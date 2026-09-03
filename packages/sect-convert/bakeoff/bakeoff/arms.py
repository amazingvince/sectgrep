"""The arms: layout orchestrators (Docling, Marker) with their own OCR, the three permitted VLMs
through their official pipelines on a vLLM server (the "sdk" arms), and the same VLMs through
the converter's transcriber boundary, one page image per request against the same server (the
"api" arms). Each arm writes work/<arm>/<doc>.md and work/<arm>/<doc>.json (timing).

Environments are uv virtual environments under ~/venvs (Docker is not available in this WSL2
install; GOAL.md asked for containers, and this is the recorded substitute). Model weights:
PaddleOCR-VL-1.5 (Apache-2.0), GLM-OCR (MIT), olmOCR-2-7B-1025 (Apache-2.0). MinerU2.5 is
AGPL-3.0 and was not downloaded.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

from .manifest import ROOT, RAW

HOME = Path.home()
VENVS = HOME / "venvs"
WORK = RAW / "work"
SERVER = os.environ.get("SECT_VLLM", "http://127.0.0.1:8000/v1")

MODELS = {
    "olmocr": {"repo": "allenai/olmOCR-2-7B-1025", "prompt_page": None, "long_side": 1288, "max_tokens": 8000, "vllm_args": ["--max-model-len", "16384"]},
    "glmocr": {"repo": "zai-org/GLM-OCR", "prompt_page": "Text Recognition:", "prompt_table": "Table Recognition:", "long_side": 1540, "max_tokens": 8192, "vllm_args": ["--allowed-local-media-path", "/", "--max-model-len", "16384"]},
    "paddle": {"repo": "PaddlePaddle/PaddleOCR-VL-1.5", "prompt_page": "OCR:", "prompt_table": "Table Recognition:", "long_side": 1540, "max_tokens": 8192, "vllm_args": ["--max-model-len", "16384"]},
}
OLMOCR_PROMPT = (
    "Attached is one page of a document that you must process. Just return the plain text representation of this document as if you were reading it naturally. "
    "Convert equations to LateX and tables to markdown.\nReturn your output as markdown, with a front matter section on top specifying values for the primary_language, "
    "is_rotation_valid, rotation_correction, is_table, and is_diagram parameters."
)


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def layout_env() -> dict:
    """Docling and Marker run on the second GPU (the RTX 4090, PCI index 1) so they can overlap
    with a vLLM server on the first."""
    return dict(os.environ, CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=os.environ.get("SECT_GPU_LAYOUT", "1"))


def doc_pdf(doc: dict) -> Path:
    """One PDF per document: the granule as fetched, or the single scanned page split out."""
    pages = RAW / "pages"
    pages.mkdir(exist_ok=True)
    src = ROOT / doc["pdf"]
    out = pages / f"{doc['doc']}.pdf"
    if out.exists():
        return out
    if doc["group"] == "scan":
        p = doc["pages"][0]
        sh(["pdfseparate", "-f", str(p), "-l", str(p), str(src), str(out)], check=True)
    else:
        shutil.copy(src, out)
    return out


def choose_dpi(width_pt: float, height_pt: float, long_side: int, min_dpi: int = 100, max_pixels: int = 3_000_000, native_dpi: int | None = None) -> int:
    """Mirror of packages/sect-convert/src/ocr/render.ts chooseDpi."""
    dpi = long_side / max(width_pt, height_pt) * 72
    dpi = min(dpi, native_dpi) if native_dpi else max(dpi, min_dpi)
    pixels = (width_pt / 72) * dpi * (height_pt / 72) * dpi
    if pixels > max_pixels:
        dpi *= (max_pixels / pixels) ** 0.5
    return round(dpi)


def page_sizes(pdf: Path) -> list[tuple[float, float]]:
    out = sh(["pdfinfo", "-f", "1", "-l", "1000", str(pdf)], check=True).stdout
    sizes = []
    for line in out.splitlines():
        if "size:" in line and line.startswith("Page"):
            parts = line.split()
            sizes.append((float(parts[3]), float(parts[5])))
    return sizes


def render(pdf: Path, page: int, dpi: int, out_png: Path) -> None:
    sh(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), "-png", "-singlefile", str(pdf), str(out_png.with_suffix(""))], check=True)


def write_result(arm: str, doc: str, markdown: str, meta: dict) -> None:
    d = WORK / arm
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{doc}.md").write_text(markdown, encoding="utf-8")
    (d / f"{doc}.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def done(arm: str, doc: str) -> bool:
    return (WORK / arm / f"{doc}.md").exists()


# ---- layout orchestrators ---------------------------------------------------------------------

def run_docling(doc: dict) -> None:
    pdf = doc_pdf(doc)
    out = WORK / "docling" / "raw" / doc["doc"]
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    ocr = ["--ocr"] if doc["group"] == "scan" else ["--no-ocr"]
    r = sh([str(VENVS / "docling" / "bin" / "docling"), str(pdf), "--to", "md", "--output", str(out), *ocr, "--device", "cuda"], env=layout_env())
    md = next(out.glob("*.md"), None)
    write_result("docling", doc["doc"], md.read_text(encoding="utf-8") if md else "", {"elapsed_s": time.time() - t0, "rc": r.returncode, "stderr": r.stderr[-800:]})


def run_marker(doc: dict) -> None:
    pdf = doc_pdf(doc)
    out = WORK / "marker" / "raw" / doc["doc"]
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    force = ["--force_ocr"] if doc["group"] == "scan" else []
    r = sh([str(VENVS / "marker" / "bin" / "marker_single"), str(pdf), "--output_dir", str(out), "--output_format", "markdown", *force], env=layout_env())
    md = next(out.rglob("*.md"), None)
    write_result("marker", doc["doc"], md.read_text(encoding="utf-8") if md else "", {"elapsed_s": time.time() - t0, "rc": r.returncode, "stderr": r.stderr[-800:]})


# ---- vLLM server --------------------------------------------------------------------------------

def server_up(url: str = SERVER) -> str | None:
    try:
        with urllib.request.urlopen(f"{url}/models", timeout=3) as r:
            data = json.load(r)
            return data["data"][0]["id"] if data.get("data") else None
    except Exception:
        return None


def start_server(model_key: str, port: int = 8000) -> subprocess.Popen:
    m = MODELS[model_key]
    log = open(HOME / "bakeoff" / f"vllm-{model_key}.log", "w")
    cmd = [str(VENVS / "vllm" / "bin" / "vllm"), "serve", m["repo"], "--port", str(port), "--host", "0.0.0.0", "--gpu-memory-utilization", "0.85", "--trust-remote-code", *m["vllm_args"]]
    # PCI bus order so index 0 is the RTX 5090 (32 GB) whatever CUDA's default enumeration says.
    env = dict(os.environ, CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=os.environ.get("SECT_GPU", "0"))
    p = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env)
    for _ in range(600):
        if server_up(f"http://127.0.0.1:{port}/v1"):
            return p
        if p.poll() is not None:
            raise RuntimeError(f"vllm exited early; see {log.name}")
        time.sleep(2)
    p.terminate()
    raise RuntimeError(f"vllm did not come up in 20 minutes; see {log.name}")


# ---- the api arm: the converter's transcriber boundary, mirrored in Python ----------------------

def chat_page(model_key: str, png: Path, prompt: str, server: str = SERVER) -> tuple[str, dict, float]:
    m = MODELS[model_key]
    body = {
        "model": m["repo"], "temperature": 0, "max_tokens": m["max_tokens"],
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png.read_bytes()).decode()}},
            {"type": "text", "text": prompt},
        ]}],
    }
    req = urllib.request.Request(f"{server}/chat/completions", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=900) as r:
        data = json.load(r)
    content = data["choices"][0]["message"]["content"]
    if isinstance(content, list):
        content = "".join(c.get("text", "") for c in content)
    return content.strip(), data.get("usage", {}), time.time() - t0


def run_api(model_key: str, doc: dict, long_side: int | None = None, tag: str | None = None) -> None:
    arm = tag or f"api-{model_key}"
    pdf = doc_pdf(doc)
    m = MODELS[model_key]
    long_side = long_side or m["long_side"]
    prompt = OLMOCR_PROMPT if model_key == "olmocr" else m["prompt_page"]
    pages_dir = WORK / arm / "png" / doc["doc"]
    pages_dir.mkdir(parents=True, exist_ok=True)
    sizes = page_sizes(pdf)
    md_parts, meta = [], {"pages": [], "arm": arm, "long_side": long_side}
    for i, (w, h) in enumerate(sizes, start=1):
        dpi = choose_dpi(w, h, long_side, native_dpi=doc.get("native_dpi"))
        png = pages_dir / f"p{i}.png"
        render(pdf, i, dpi, png)
        text, usage, secs = chat_page(model_key, png, prompt)
        md_parts.append(text)
        meta["pages"].append({"page": i, "dpi": dpi, "usage": usage, "elapsed_s": secs})
    write_result(arm, doc["doc"], "\n\n".join(md_parts), meta)


# ---- the sdk arms: the official pipelines pointed at the same server ---------------------------

def run_sdk_olmocr(docs: list[dict]) -> None:
    ws = WORK / "sdk-olmocr" / "workspace"
    ws.mkdir(parents=True, exist_ok=True)
    pdfs = [str(doc_pdf(d)) for d in docs if not done("sdk-olmocr", d["doc"])]
    if not pdfs:
        return
    t0 = time.time()
    r = sh([str(VENVS / "olmocr" / "bin" / "python"), "-m", "olmocr.pipeline", str(ws), "--server", SERVER, "--model", MODELS["olmocr"]["repo"], "--markdown", "--pdfs", *pdfs])
    per = (time.time() - t0) / max(1, len(pdfs))
    for d in docs:
        md = next((ws / "markdown").rglob(f"{d['doc']}.md"), None)
        write_result("sdk-olmocr", d["doc"], md.read_text(encoding="utf-8") if md else "", {"elapsed_s": per, "rc": r.returncode, "stderr": r.stderr[-800:]})


def run_sdk_paddle(doc: dict) -> None:
    pdf = doc_pdf(doc)
    out = WORK / "sdk-paddle" / "raw" / doc["doc"]
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    r = sh([str(VENVS / "paddle" / "bin" / "paddleocr"), "doc_parser", "-i", str(pdf), "--pipeline_version", "v1.5", "--vl_rec_backend", "vllm-server", "--vl_rec_server_url", SERVER, "--save_path", str(out)])
    mds = sorted(out.rglob("*.md"))
    write_result("sdk-paddle", doc["doc"], "\n\n".join(m.read_text(encoding="utf-8") for m in mds), {"elapsed_s": time.time() - t0, "rc": r.returncode, "stderr": r.stderr[-800:]})


def run_sdk_glmocr(doc: dict) -> None:
    pdf = doc_pdf(doc)
    out = WORK / "sdk-glmocr" / "raw" / doc["doc"]
    out.mkdir(parents=True, exist_ok=True)
    cfg = WORK / "sdk-glmocr" / "config.yaml"
    if not cfg.exists():
        cfg.write_text("pipeline:\n  maas:\n    enabled: false\n  ocr_api:\n    api_host: 127.0.0.1\n    api_port: 8000\n", encoding="utf-8")
    t0 = time.time()
    r = sh([str(VENVS / "glmocr" / "bin" / "glmocr"), "parse", str(pdf), "--output", str(out), "--layout-device", "cpu", "--config", str(cfg)])
    mds = sorted(out.rglob("*.md"))
    write_result("sdk-glmocr", doc["doc"], "\n\n".join(m.read_text(encoding="utf-8") for m in mds), {"elapsed_s": time.time() - t0, "rc": r.returncode, "stderr": r.stderr[-800:]})
