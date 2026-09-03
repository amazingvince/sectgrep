#!/usr/bin/env python3
"""Milestone C1 evidence (GOAL.md G-E): converts the eCFR titles under raw/ with timing, converts
the Federal Register rules under raw/fr/, validates the corpus contract, reads the index status,
and summarises every extraction report under work/. Writes eval/results/c1.md.

    python eval/eval_c1.py [--skip-convert]

Needs the converter built (pnpm --filter @sectgrep/convert build) and a release sect binary.
"""
from __future__ import annotations

import glob
import json
import os
import platform
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "packages" / "sect-convert" / "dist" / "cli.js"
SECT = next((p for p in [ROOT / "target" / "release" / "sect.exe", ROOT / "target" / "release" / "sect"] if p.exists()), Path("sect"))
CORPUS = ROOT / "corpora" / "ecfr"
OUT = ROOT / "eval" / "results" / "c1.md"


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        sys.exit(f"{' '.join(str(c) for c in cmd)}\n{r.stdout}\n{r.stderr}")
    return r


def convert_titles() -> list[dict]:
    rows = []
    for xml in sorted(glob.glob(str(ROOT / "raw" / "cfr-title-*" / "*" / "ECFR-title*.xml"))):
        title = int(re.search(r"ECFR-title(\d+)\.xml", xml).group(1))
        t0 = time.perf_counter()
        r = run(["node", str(CLI), "ecfr", "--xml", xml, "--title", str(title), "--out", str(CORPUS)])
        secs = time.perf_counter() - t0
        m = re.search(r"converted Title (\d+) \((.*?)\): (\d+) sections, (\d+) nodes, effective (\S+) -> .*?\((\d+) files; (\d+) effdnot, (\d+) crossref", r.stdout)
        rows.append({"title": title, "name": m.group(2), "sections": int(m.group(3)), "nodes": int(m.group(4)), "effective": m.group(5), "files": int(m.group(6)), "effdnot": int(m.group(7)), "crossref": int(m.group(8)), "seconds": secs, "bytes": os.path.getsize(xml)})
    return rows


def convert_fr() -> list[dict]:
    r = run(["node", str(CLI), "fr", "--xml", str(ROOT / "raw" / "fr"), "--out", str(CORPUS)])
    rows = []
    for m in re.finditer(r"^(FR:\S+) effective (\S+): (\d+) action candidate\(s\) \[(.*?)\]", r.stdout, re.M):
        kinds = Counter(k.split(" ")[0] for k in m.group(4).split("; ") if k)
        rows.append({"id": m.group(1), "effective": m.group(2), "actions": int(m.group(3)), "kinds": dict(kinds)})
    return rows


def validate() -> dict:
    t0 = time.perf_counter()
    r = run([str(SECT), "index", "--validate-only", str(CORPUS)], check=False)
    secs = time.perf_counter() - t0
    lines = (r.stdout + r.stderr).splitlines()
    errors = [l for l in lines if l.startswith("error:")]
    warnings = [l for l in lines if l.startswith("warning:")]
    kinds = Counter(re.sub(r"\(line \d+\)", "", re.sub(r"`[^`]*`", "X", l.split(": ", 2)[-1])).strip() for l in warnings)
    m = re.search(r"validated (\d+) files in (\d+) ms", r.stdout + r.stderr)
    return {"exit": r.returncode, "errors": errors, "warnings": len(warnings), "warning_kinds": kinds.most_common(8), "files": int(m.group(1)) if m else None, "ms": int(m.group(2)) if m else None, "seconds": secs}


def status() -> dict:
    # The index is refreshed first (a full build when .sect/ is absent, incremental otherwise) so
    # the counts describe the files just converted.
    full = not (CORPUS / ".sect").exists()
    t0 = time.perf_counter()
    run([str(SECT), "index", str(CORPUS)])
    build = time.perf_counter() - t0
    r = run([str(SECT), "status", "--corpus", str(CORPUS), "--json"])
    j = json.loads(r.stdout)
    counts = j["counts"]
    extra = dict(counts.get("extra", []))
    return {"files": counts["works"], "sources": j["result"]["sources"], "unresolved_refs": extra.get("unresolved-refs"), "warnings": extra.get("warnings"), "build_seconds": build, "full_build": full}


GOLDEN_PAGES = {"scan-sample.pdf": {1: "FR-1975-03-03-p12", 2: "FR-1975-03-03-p20", 3: "FR-1985-06-03-p6"}}


def words(text: str) -> list[str]:
    lines = text.lstrip("﻿").replace("\r", "").split("\n")
    if lines and lines[0].strip() == "---":
        # olmOCR-2's metadata block as a front matter: --- ... ---
        for i, l in enumerate(lines[1:12], 1):
            if l.strip() == "---":
                lines = lines[i + 1 :]
                break
    elif lines and re.match(r"^[a-z_]+:\s*\S", lines[0]):
        # the same block without the opening delimiter, closed by ---
        for i, l in enumerate(lines[:10]):
            if l.strip() == "---":
                lines = lines[i + 1 :]
                break
    # A golden opens with its own title line and a provenance comment, neither of them page text.
    body = " ".join(l for l in lines if l.strip() != "---" and not l.startswith("<!--") and not re.match(r"^# FR-\d{4}-\d{2}-\d{2}-p\d+", l))
    body = re.sub(r"[*_`#>|]", "", body)
    return [w for w in re.split(r"\s+", body.strip()) if w]


def edit_distance(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def ocr_truth(reps: list[dict]) -> list[dict]:
    """Word error rate of each raw reading against the C0 consensus golden for the same page."""
    rows = []
    for r in reps:
        pages = GOLDEN_PAGES.get(Path(r["input"]).name)
        if not r.get("ocr") or not pages:
            continue
        d = ROOT / r["dir"]
        for page, doc in pages.items():
            golden = ROOT / "eval" / "golden" / "bakeoff" / "scan" / f"{doc}.md"
            if not golden.exists():
                continue
            g = words(golden.read_text(encoding="utf-8"))
            row = {"input": Path(r["input"]).name, "page": page, "golden": doc, "golden_words": len(g)}
            for which in ("primary", "secondary"):
                f = d / "ocr" / f"p{page}-{which}.md"
                if f.exists():
                    w = words(f.read_text(encoding="utf-8"))
                    row[which] = edit_distance(w, g) / max(len(g), 1)
            rows.append(row)
    return rows


def reports() -> list[dict]:
    rows = []
    for f in sorted(glob.glob(str(ROOT / "work" / "*" / "report.json"))):
        j = json.load(open(f, encoding="utf-8"))
        d = Path(f).parent
        xrefs = sum(1 for _ in open(d / "xrefs_candidates.jsonl", encoding="utf-8")) if (d / "xrefs_candidates.jsonl").exists() else 0
        terms = len(json.load(open(d / "terms_candidates.json", encoding="utf-8"))) if (d / "terms_candidates.json").exists() else 0
        heads = 0
        native = 0
        if (d / "elements.jsonl").exists():
            for line in open(d / "elements.jsonl", encoding="utf-8"):
                e = json.loads(line)
                heads += e["type"] == "heading"
                native += any(fl.startswith("native_id:") for fl in e["flags"])
        rows.append({**j, "xrefs": xrefs, "terms": terms, "headings": heads, "native_ids": native, "dir": str(d.relative_to(ROOT))})
    return rows


def main() -> None:
    skip = "--skip-convert" in sys.argv
    titles = [] if skip else convert_titles()
    fr = [] if skip else convert_fr()
    val = validate()
    st = status()
    reps = reports()
    node = run(["node", "--version"]).stdout.strip()
    md = []
    md.append("# Milestone C1: native parsers, elements, dual-transcriber OCR\n")
    md.append(f"Generated by `python eval/eval_c1.py` on {platform.system()} {platform.release()}, node {node}, `{SECT.name}` {run([str(SECT), '--version']).stdout.strip()}.\n")
    md.append("## eCFR titles (GPO bulk XML -> B.2 contract)\n")
    md.append("| Title | Name | XML MB | Sections | Nodes | Files | EFFDNOT | CROSSREF | Effective | Convert s |")
    md.append("|---|---|---|---|---|---|---|---|---|---|")
    for t in titles:
        md.append(f"| {t['title']} | {t['name']} | {t['bytes'] / 1e6:.1f} | {t['sections']} | {t['nodes']} | {t['files']} | {t['effdnot']} | {t['crossref']} | {t['effective']} | {t['seconds']:.1f} |")
    if skip:
        md.append("| (conversion skipped: --skip-convert) | | | | | | | | | |")
    md.append("")
    md.append("EFFDNOT and CROSSREF records are written as candidates under `corpora/ecfr/.work/cfr-title-N/` (effdnot.jsonl, crossref.jsonl), outside the corpus walk.\n")
    md.append("## Federal Register rules (rule XML -> notice + Action candidates)\n")
    md.append("| Notice | Effective | Actions | Kinds |")
    md.append("|---|---|---|---|")
    for n in fr:
        md.append(f"| {n['id']} | {n['effective']} | {n['actions']} | {', '.join(f'{k} {v}' for k, v in sorted(n['kinds'].items()))} |")
    md.append(f"\n{len(fr)} notices, {sum(n['actions'] for n in fr)} Action candidates.\n")
    md.append("## Contract validation and index\n")
    md.append(f"`sect index --validate-only corpora/ecfr`: exit {val['exit']}, {len(val['errors'])} errors, {val['warnings']} warnings, {val['files']} files in {val['ms']} ms.\n")
    for e in val["errors"][:20]:
        md.append(f"- {e}")
    md.append("\nWarning kinds (backticked names replaced by X):\n")
    md.append("| Count | Warning |")
    md.append("|---|---|")
    for k, c in val["warning_kinds"]:
        md.append(f"| {c} | {k} |")
    md.append("")
    md.append(f"`sect status`: {st['files']} works, unresolved refs {st['unresolved_refs']}, warnings {st['warnings']}" + (f", full index build {st['build_seconds']:.1f} s" if st["build_seconds"] else "") + ".\n")
    md.append("| Source | Kind | Files |")
    md.append("|---|---|---|")
    for s in st["sources"]:
        md.append(f"| {s['name']} | {s['kind']} | {s['files']} |")
    md.append("")
    md.append("## Element extraction (work/<raw_sha256>/)\n")
    md.append("| Input | Format | Pages | Scanned | Elements | Headings | Native ids | Tables | Xref cands | Term cands | ms |")
    md.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in sorted(reps, key=lambda r: (r["format"], r["input"])):
        md.append(f"| {Path(r['input']).name} | {r['format']} | {len(r['pages'])} | {len(r['scanned_pages'])} | {r['elements']} | {r['headings']} | {r['native_ids']} | {r['tables']} | {r['xrefs']} | {r['terms']} | {r['elapsed_ms']} |")
    md.append("")
    ocr = [r for r in reps if r.get("ocr")]
    if ocr:
        md.append("## Scanned pages: dual transcription\n")
        md.append("| Input | Primary | Secondary | Pages | Lines | Divergent | Unverified pages | ms |")
        md.append("|---|---|---|---|---|---|---|---|")
        for r in ocr:
            o = r["ocr"]
            md.append(f"| {Path(r['input']).name} | {o['primary']} | {o['secondary']} | {o['pages']} | {o['lines']} | {o['divergent_lines']} ({100 * o['divergent_lines'] / max(o['lines'], 1):.0f}%) | {', '.join(str(p) for p in o.get('unverified_pages', [])) or 'none'} | {r['elapsed_ms']} |")
        md.append("")
        md.append("Lines that agree are accepted at confidence 1; a divergent line keeps the primary's reading with the secondary's words for the same span in `alt_text`, flagged `ocr_divergent`; a secondary line with no counterpart is kept flagged `secondary_only`. A page whose secondary reading is unusable (looping, or a word count far from the primary's) keeps the primary's lines flagged `ocr_unverified` instead. Both raw readings sit under `ocr/` in the work directory.\n")
        truth = ocr_truth(reps)
        if truth:
            md.append("Word error rate of each raw reading against the C0 consensus golden for the same page (lower is better):\n")
            md.append("| Page | Golden | Golden words | Primary WER | Secondary WER |")
            md.append("|---|---|---|---|---|")
            for t in truth:
                md.append(f"| {t['page']} | {t['golden']} | {t['golden_words']} | {t.get('primary', float('nan')):.3f} | {t.get('secondary', float('nan')):.3f} |")
            md.append("")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(md) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(titles)} titles, {len(fr)} notices, validate exit {val['exit']} ({len(val['errors'])} errors, {val['warnings']} warnings), {len(reps)} extraction reports")


if __name__ == "__main__":
    main()
