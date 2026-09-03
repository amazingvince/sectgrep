"""eval/results/c0.md: the score table per arm and group, and the recommendation."""

from __future__ import annotations

import datetime as dt
import statistics
from collections import defaultdict
from pathlib import Path

from .manifest import ROOT

OUT = ROOT / "eval" / "results" / "c0.md"
ARM_LABEL = {
    "docling": "Docling 2.x (layout + EasyOCR on scans)",
    "marker": "Marker 2.x (layout + Surya OCR)",
    "sdk-olmocr": "olmOCR-2-7B (official pipeline on vLLM)",
    "api-olmocr": "olmOCR-2-7B (converter API path: page image + prompt)",
    "sdk-glmocr": "GLM-OCR 0.9B (official SDK, PP-DocLayoutV3 + vLLM)",
    "api-glmocr": "GLM-OCR 0.9B (converter API path: page image + prompt)",
    "sdk-paddle": "PaddleOCR-VL-1.5 0.9B (official pipeline on vLLM)",
    "api-paddle": "PaddleOCR-VL-1.5 0.9B (converter API path: page image + prompt)",
}


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def fmt(x, nd=3):
    return "" if x is None else f"{x:.{nd}f}"


def write_report(manifest: dict, rows: list[dict]) -> Path:
    by = defaultdict(list)
    for r in rows:
        by[(r["arm"], r["group"])].append(r)
    arms = sorted({r["arm"] for r in rows}, key=lambda a: list(ARM_LABEL).index(a) if a in ARM_LABEL else 99)
    L = [
        "# Milestone C0 results: extractor and OCR bake-off (spec C.3, H.6)\n",
        f"Generated {dt.datetime.now().isoformat(timespec='seconds')}. Documents: {len(manifest['docs'])} ({manifest['pages_total']} pages): 10 born-digital eCFR granules (Title 29, 2024 annual edition, GovInfo PDF with the matching XML as ground truth), 10 granules with tables (same source; TEDS on GPOTABLE), 10 scanned pre-1994 Federal Register pages (1975 and 1985 issues, 100 DPI scans, no text layer; ground truth is a flagged line-level consensus of the transcribers, to be hand-checked, see eval/golden/bakeoff/scan/).\n",
        "Metrics: TextEdit = normalized edit distance of the section text (lower is better, 0 perfect); Read order = normalized edit distance of the golden blocks in the order the model emitted them (lower is better); Block miss = golden blocks the model output did not contain; TEDS = tree edit distance similarity of tables (higher is better, 1 perfect). Medians per group; seconds per document as wall time of the arm. Local inference only: one vLLM server per model on the RTX 5090 in WSL2; no paid vision API was called (see the TODO at the end).\n",
        "## Scores (median per group)\n",
        "| Arm | Born TextEdit | Born read order | Born block miss | Table TextEdit | Table TEDS | Scan TextEdit (vs consensus) | Scan read order | s/doc |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    summary = {}
    for a in arms:
        b, t, s = by.get((a, "born"), []), by.get((a, "table"), []), by.get((a, "scan"), [])
        row = {
            "born_te": med([r["text_edit"] for r in b]), "born_ro": med([r["read_order"] for r in b]), "born_miss": med([r["block_miss"] for r in b]),
            "table_te": med([r["text_edit"] for r in t]), "teds": med([r["teds"] for r in t]),
            "scan_te": med([r["text_edit"] for r in s]), "scan_ro": med([r["read_order"] for r in s]),
            "secs": med([r["elapsed_s"] for r in b + t + s]),
            "n": len(b) + len(t) + len(s), "empty": sum(1 for r in b + t + s if r["empty"]),
        }
        summary[a] = row
        L.append(f"| {ARM_LABEL.get(a, a)} | {fmt(row['born_te'])} | {fmt(row['born_ro'])} | {fmt(row['born_miss'])} | {fmt(row['table_te'])} | {fmt(row['teds'])} | {fmt(row['scan_te'])} | {fmt(row['scan_ro'])} | {fmt(row['secs'], 1)} |")
    L.append("")
    # Recommendation: rank transcriber arms by born TextEdit then read order (the C.3 criterion).
    vlm = [a for a in arms if a.startswith(("sdk-", "api-")) and summary[a]["born_te"] is not None]
    ranked = sorted(vlm, key=lambda a: (summary[a]["born_te"], summary[a]["born_ro"] or 1))
    L.append("## Recommendation\n")
    if ranked:
        primary = ranked[0]
        fam = lambda a: a.split("-", 1)[1]
        secondary = next((a for a in ranked[1:] if fam(a) != fam(primary)), None)
        L.append(f"- **Primary transcriber:** {ARM_LABEL.get(primary, primary)}: born-digital TextEdit {fmt(summary[primary]['born_te'])}, read order {fmt(summary[primary]['born_ro'])}, table TEDS {fmt(summary[primary]['teds'])}.")
        if secondary:
            L.append(f"- **Secondary (independent architecture, for divergence checks):** {ARM_LABEL.get(secondary, secondary)}: TextEdit {fmt(summary[secondary]['born_te'])}, read order {fmt(summary[secondary]['born_ro'])}, TEDS {fmt(summary[secondary]['teds'])}.")
        L.append("- Selection criterion per spec C.3: TextEdit and reading order on legal text over table TEDS; the full ranking by that criterion is " + ", ".join(f"{a} ({fmt(summary[a]['born_te'])})" for a in ranked) + ".")
    lay = [a for a in arms if a in ("docling", "marker")]
    if lay:
        best = min(lay, key=lambda a: (summary[a]["born_te"] or 1, summary[a]["born_ro"] or 1))
        L.append(f"- **Layout orchestrator for born-digital pages:** {ARM_LABEL.get(best, best)} (TextEdit {fmt(summary[best]['born_te'])}, TEDS {fmt(summary[best]['teds'])}, {fmt(summary[best]['secs'], 1)} s/doc).")
    L.append("")
    L.append("## Per-document scores\n")
    L.append("| Arm | Doc | Group | Pages | TextEdit | Read order | Block miss | TEDS | Tables found | s | Chars |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in sorted(rows, key=lambda r: (r["group"], r["doc"], r["arm"])):
        tf = f"{r.get('tables_found')}/{r.get('tables_gold')}" if r.get("tables_gold") else ""
        L.append(f"| {r['arm']} | {r['doc']} | {r['group']} | {r['pages']} | {fmt(r['text_edit'])} | {fmt(r['read_order'])} | {fmt(r['block_miss'])} | {fmt(r['teds'])} | {tf} | {fmt(r['elapsed_s'], 1)} | {r['chars']} |")
    L.append("")
    L.append("## Pricing and the paid arm (TODO for a human)\n")
    L.append("No paid vision API was called (GOAL.md constraint). Local inference cost: electricity only, on hardware already owned; the RTX 5090 ran every model. If a hosted arm is wanted as the secondary transcriber, confirm current per-image or per-token pricing for the candidate flash/lite vision models before any run; the spec's survey could not retrieve 2026 prices (H.6). The converter's transcriber boundary takes a base URL and key, so a hosted model plugs in without code changes.\n")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    return OUT
