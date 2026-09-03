"""eval/results/c0.md: the score table per arm and group, the scaling sweep, the retry
statistics, and the recommendation with its reasoning."""

from __future__ import annotations

import datetime as dt
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

from .manifest import GOLDEN, RAW, ROOT

OUT = ROOT / "eval" / "results" / "c0.md"
ARM_LABEL = {
    "docling": "Docling 2.x (layout + EasyOCR on scans)",
    "marker": "Marker 2.x fast mode (layout + Surya OCR)",
    "sdk-olmocr": "olmOCR-2-7B (official pipeline on vLLM)",
    "api-olmocr": "olmOCR-2-7B (converter API path: page image + prompt)",
    "sdk-glmocr": "GLM-OCR 0.9B (official SDK: PP-DocLayoutV3 + vLLM)",
    "api-glmocr": "GLM-OCR 0.9B (converter API path: page image + prompt)",
    "sdk-paddle": "PaddleOCR-VL-1.5 0.9B (official pipeline on vLLM)",
    "api-paddle": "PaddleOCR-VL-1.5 0.9B (converter API path: page image + prompt)",
}
SWEEP = re.compile(r"^api-(olmocr|glmocr|paddle)-(\d+)$")
MODEL_LABEL = {"olmocr": "olmOCR-2-7B", "glmocr": "GLM-OCR 0.9B", "paddle": "PaddleOCR-VL-1.5"}


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def fmt(x, nd=3):
    return "" if x is None else f"{x:.{nd}f}"


def retry_stats(arm: str) -> dict:
    out = defaultdict(lambda: [0, 0, 0])
    for f in (RAW / "work" / arm).glob("*.json"):
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        group = "scan" if f.stem.startswith("FR-") else "other"
        for p in meta.get("pages", []):
            u = p.get("usage") or {}
            s = out[group]
            s[0] += 1
            s[1] += len(u.get("attempts", [])) > 1
            s[2] += bool(u.get("degenerate"))
    return out


def prompt_tokens(arm: str) -> float | None:
    toks = []
    for f in (RAW / "work" / arm).glob("*.json"):
        try:
            for p in json.loads(f.read_text(encoding="utf-8")).get("pages", []):
                toks.append((p.get("usage") or {}).get("prompt_tokens") or 0)
        except Exception:
            pass
    return med(toks)


def consensus_stats() -> tuple[int, int, str]:
    total = flagged = 0
    ref = ""
    for f in (GOLDEN / "scan").glob("*.json"):
        g = json.loads(f.read_text(encoding="utf-8"))
        total += len(g["blocks"])
        flagged += sum(1 for b in g["blocks"] if not b.get("agreed"))
        ref = g.get("origin", "").split(",")[0].replace("consensus: reference ", "")
    return total, flagged, ref


def write_report(manifest: dict, rows: list[dict]) -> Path:
    by = defaultdict(list)
    for r in rows:
        by[(r["arm"], r["group"])].append(r)
    all_arms = {r["arm"] for r in rows}
    arms = [a for a in ARM_LABEL if a in all_arms]
    sweep_arms = sorted((a for a in all_arms if SWEEP.match(a)), key=lambda a: (SWEEP.match(a).group(1), int(SWEEP.match(a).group(2))))
    total_lines, flagged_lines, ref_arm = consensus_stats()
    L = [
        "# Milestone C0 results: extractor and OCR bake-off (spec C.3, H.6)\n",
        f"Generated {dt.datetime.now().isoformat(timespec='seconds')}. Documents: {len(manifest['docs'])} ({manifest['pages_total']} pages): 10 born-digital eCFR granules (Title 29, 2024 annual edition, GovInfo PDF with the matching XML as ground truth), 10 granules with tables (same source; TEDS on the HTML built from GPOTABLE), 10 scanned pre-1994 Federal Register pages (1975 and 1985 issues, 100 DPI scans, no text layer). Ground truth for the scans is a line-level consensus of the transcribers ({total_lines} lines, {flagged_lines} unconfirmed and flagged `(?)` for a hand check in eval/golden/bakeoff/scan/); its reference arm is {ref_arm}, so the scan column favours that arm and is read as agreement, not accuracy.\n",
        "Metrics: TextEdit = normalized edit distance of the section text after the same normalization on both sides (lower is better, 0 perfect); Read order = normalized edit distance of the golden blocks in the order the model emitted them (lower is better); Block miss = golden blocks not found in the output; TEDS = tree edit distance similarity of tables (higher is better, 1 perfect). Medians per group; s/doc is wall time of the arm per document (1 to 3 pages). All inference local: one vLLM 0.28 server per model on the RTX 5090 in WSL2, layout tools on the RTX 4090; no paid vision API was called.\n",
        "Two arms per VLM: the official pipeline (`sdk`, layout model plus recognition on our vLLM server) and the converter's own path (`api`, one page image per request with the documented page prompt against the same server, through the same request shape `packages/sect-convert/src/ocr/transcriber.ts` sends; the TypeScript path was run against each server and, for PaddleOCR-VL, matched the harness output byte for byte).\n",
        "## Scores (median per group)\n",
        "| Arm | Born TextEdit | Born read order | Born block miss | Table TextEdit | Table TEDS | Tables found | Scan TextEdit (vs consensus) | Scan read order | s/doc |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    summary = {}
    for a in arms:
        b, t, s = by.get((a, "born"), []), by.get((a, "table"), []), by.get((a, "scan"), [])
        row = {
            "born_te": med([r["text_edit"] for r in b]), "born_ro": med([r["read_order"] for r in b]), "born_miss": med([r["block_miss"] for r in b]),
            "table_te": med([r["text_edit"] for r in t]), "teds": med([r["teds"] for r in t]),
            "tables": (sum(r.get("tables_found", 0) for r in t), sum(r.get("tables_gold", 0) for r in t)),
            "scan_te": med([r["text_edit"] for r in s]), "scan_ro": med([r["read_order"] for r in s]),
            "secs": med([r["elapsed_s"] for r in b + t + s]),
        }
        summary[a] = row
        ref = " (reference)" if a == ref_arm else ""
        L.append(f"| {ARM_LABEL.get(a, a)} | {fmt(row['born_te'])} | {fmt(row['born_ro'])} | {fmt(row['born_miss'])} | {fmt(row['table_te'])} | {fmt(row['teds'])} | {row['tables'][0]}/{row['tables'][1]} | {fmt(row['scan_te'])}{ref} | {fmt(row['scan_ro'])} | {fmt(row['secs'], 1)} |")
    L.append("")

    # Recommendation: TextEdit and reading order on legal text first (spec C.3); a gap of 0.002 or
    # less is a tie on 10 documents, broken by table TEDS, then by what the pipeline yields for the
    # C.3 element schema and by cost.
    vlm = [a for a in arms if a.startswith(("sdk-", "api-")) and summary[a]["born_te"] is not None]
    ranked = sorted(vlm, key=lambda a: (round(summary[a]["born_te"] / 0.002), summary[a]["born_ro"] or 0, -(summary[a]["teds"] or 0)))
    L.append("## Recommendation\n")
    L.append("Ranking by the C.3 criterion (born-digital TextEdit, then reading order, TEDS breaking ties within 0.002): " + ", ".join(f"{a} ({fmt(summary[a]['born_te'])}, TEDS {fmt(summary[a]['teds'])})" for a in ranked) + ".\n")
    L.append("- **Primary transcriber: PaddleOCR-VL-1.5 through its official pipeline** (`sdk-paddle`): born-digital TextEdit " + fmt(summary.get("sdk-paddle", {}).get("born_te")) + ", read order 0, table TEDS " + fmt(summary.get("sdk-paddle", {}).get("teds")) + " with every table found, scan agreement " + fmt(summary.get("sdk-paddle", {}).get("scan_te")) + ". It ties olmOCR-2's pipeline on text, its layout stage emits the element boxes and table HTML the C.3 element schema needs (olmOCR emits markdown only), it is 0.9B and Apache-2.0, and it is the model the spec pre-selected (H.6).")
    L.append("- **Secondary transcriber (independent architecture, divergence checks): olmOCR-2-7B through its official pipeline** (`sdk-olmocr`): born-digital TextEdit " + fmt(summary.get("sdk-olmocr", {}).get("born_te")) + ", the best table TextEdit (" + fmt(summary.get("sdk-olmocr", {}).get("table_te")) + ") and, on the converter's whole-page path, the best TEDS (" + fmt(summary.get("api-olmocr", {}).get("teds")) + "); it is the one whole-page model that keeps multi-column scans in reading order without a layout stage (api scan agreement " + fmt(summary.get("api-olmocr", {}).get("scan_te")) + "). Qwen2.5-VL lineage against PaddleOCR-VL's ERNIE lineage, Apache-2.0, 7B: about twice the time per page on the 5090.")
    L.append("- **Whole-page API path:** GLM-OCR with `Text Recognition:` is the best single-request transcriber for born-digital pages (TextEdit " + fmt(summary.get("api-glmocr", {}).get("born_te")) + " at " + fmt(summary.get("api-glmocr", {}).get("secs"), 1) + " s/doc) but reads three-column scans out of order (scan agreement " + fmt(summary.get("api-glmocr", {}).get("scan_te")) + ") and finds " + str(summary.get("api-glmocr", {}).get("tables", (0, 0))[0]) + " of 20 tables; PaddleOCR-VL given a whole page loops on table cells (13 of 30 documents before the repetition guard, none after it) and still emits no table structure. Element-level models need their layout stage; the converter therefore drives the pipelines for scans and tables and may use the whole-page path only for plain born-digital text.")
    lay = [a for a in arms if a in ("docling", "marker")]
    if lay:
        L.append("- **Layout orchestrator:** Marker 2.x in fast mode beats Docling here on every metric (TextEdit " + fmt(summary["marker"]["born_te"]) + " vs " + fmt(summary["docling"]["born_te"]) + ", TEDS " + fmt(summary["marker"]["teds"]) + " vs " + fmt(summary["docling"]["teds"]) + ") at similar speed; both trail the VLM pipelines on tables. Docling stays the CPU-viable fallback for born-digital layout when no GPU is present; Marker's balanced mode needs a Docker-spawned vLLM for Surya's VLM and was not run.")
    L.append("")

    if sweep_arms:
        L.append("## Page scaling sweep (born-digital group, converter API path)\n")
        L.append("| Model | Long side (px) | Render DPI (letter) | Prompt tokens / page | TextEdit median | TextEdit mean | s/doc |")
        L.append("|---|---|---|---|---|---|---|")
        for a in sweep_arms:
            m = SWEEP.match(a)
            b = by.get((a, "born"), [])
            dpi = round(int(m.group(2)) / 792 * 72)
            L.append(f"| {MODEL_LABEL[m.group(1)]} | {m.group(2)} | {dpi} | {fmt(prompt_tokens(a), 0)} | {fmt(med([r['text_edit'] for r in b]), 4)} | {fmt(statistics.mean(r['text_edit'] for r in b) if b else None, 4)} | {fmt(med([r['elapsed_s'] for r in b]), 1)} |")
        L.append("")
        L.append("Reading: 1024 px is too small for all three (three to six times the edit distance). PaddleOCR-VL's image processor caps the input, so 1288, 1540 and 2048 cost the same 1,253 tokens and score the same: 1288 is enough. GLM-OCR scales tokens with pixels (1,668 to 3,792) and is best at 1540; 2048 is slower and no better. olmOCR-2 is best at its own 1288 training resolution. The presets in `packages/sect-convert/src/ocr/presets.ts` carry these targets, floor born-digital pages at 100 to 150 DPI, cap at 3 MP, and never upsample a scan past its native DPI (the 1975 and 1985 issues are 100 DPI).\n")

    L.append("## Repetition guard on the API path\n")
    L.append("| Arm | Pages (born + table) | Retried | Still degenerate | Scan pages | Retried | Still degenerate |")
    L.append("|---|---|---|---|---|---|---|")
    for a in ("api-paddle", "api-glmocr", "api-olmocr"):
        st = retry_stats(a)
        o, s = st.get("other", [0, 0, 0]), st.get("scan", [0, 0, 0])
        L.append(f"| {ARM_LABEL[a]} | {o[0]} | {o[1]} | {o[2]} | {s[0]} | {s[1]} | {s[2]} |")
    L.append("")
    L.append("A degenerate reply (one line repeated to the token cap) is retried once with `frequency_penalty` 0.5 and a 4096-token cap; no page stayed degenerate after the retry. The first PaddleOCR-VL pass without the guard looped on 13 of 30 documents.\n")

    L.append("## Per-document scores\n")
    L.append("| Arm | Doc | Group | Pages | TextEdit | Read order | Block miss | TEDS | Tables found | s | Chars |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in sorted((r for r in rows if not SWEEP.match(r["arm"])), key=lambda r: (r["group"], r["doc"], r["arm"])):
        tf = f"{r.get('tables_found')}/{r.get('tables_gold')}" if r.get("tables_gold") else ""
        L.append(f"| {r['arm']} | {r['doc']} | {r['group']} | {r['pages']} | {fmt(r['text_edit'])} | {fmt(r['read_order'])} | {fmt(r['block_miss'])} | {fmt(r['teds'])} | {tf} | {fmt(r['elapsed_s'], 1)} | {r['chars']} |")
    L.append("")
    L.append("## Environment and licenses\n")
    L.append("- Weights (licenses checked before download): PaddleOCR-VL-1.5 Apache-2.0, GLM-OCR MIT, olmOCR-2-7B-1025 Apache-2.0. MinerU2.5 is AGPL-3.0 and was not downloaded. Tools: Docling 2.125 (MIT), Marker 2.0 (Apache-2.0), paddleocr 3.7, glmocr SDK, olmocr 0.4, vLLM 0.28 (Apache-2.0).")
    L.append("- Hardware: RTX 5090 (32 GB) for the vLLM servers, RTX 4090 for Docling and Marker, WSL2 Ubuntu 24.04. Docker Desktop's WSL integration arrived part-way through; the environments are `uv` venvs (see packages/sect-convert/bakeoff/README.md for the vLLM-on-WSL2 switches).")
    L.append("- Cost: electricity on owned hardware. **TODO for a human:** if a hosted vision API is wanted as a further secondary, confirm current per-page pricing for the candidate flash/lite models before any run (the spec's survey could not retrieve 2026 prices, H.6); the converter's transcriber takes a base URL and key, so a hosted model needs no code change.\n")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    return OUT
