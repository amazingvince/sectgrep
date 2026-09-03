"""Golden text for the scanned pages, which have no text layer: the line-level consensus of the
transcribers' outputs. Each line of the reference arm is kept when at least one other arm has a
close match (fuzzy ratio >= 90); disagreeing lines are kept from the reference but flagged so a
person can check them against the page image. The result is marked `consensus` in provenance
and the scan scores must be read as agreement with that consensus, which favours the arms that
formed it; the primary/secondary choice therefore leans on the born-digital and table groups.
"""

from __future__ import annotations

import json
from pathlib import Path

from rapidfuzz import fuzz

from .manifest import GOLDEN, RAW, ROOT
from .score import normalize, strip_front_matter

WORK = RAW / "work"
PREFERRED = ["sdk-olmocr", "api-olmocr", "sdk-glmocr", "api-glmocr", "sdk-paddle", "api-paddle", "docling", "marker"]


def lines_of(arm: str, doc: str) -> list[str]:
    p = WORK / arm / f"{doc}.md"
    if not p.exists():
        return []
    text = strip_front_matter(p.read_text(encoding="utf-8"))
    return [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("|")]


def build_scan_golden(docs: list[dict]) -> int:
    n = 0
    for d in docs:
        if d["group"] != "scan":
            continue
        available = [a for a in PREFERRED if lines_of(a, d["doc"])]
        if len(available) < 2:
            continue
        ref, others = available[0], available[1:]
        blocks, flagged = [], 0
        for line in lines_of(ref, d["doc"]):
            agree = any(fuzz.ratio(normalize(line), normalize(o)) >= 90 for a in others for o in lines_of(a, d["doc"]) if abs(len(o) - len(line)) < max(20, len(line) // 2))
            if not agree:
                flagged += 1
            blocks.append({"kind": "para", "text": line, "page": 0, "html": None, "agreed": agree})
        out = GOLDEN / "scan"
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{d['doc']}.json").write_text(json.dumps({"doc": d["doc"], "section": None, "title": f"{d['doc']} (scanned Federal Register page)", "origin": f"consensus: reference {ref}, agreement against {others}; {flagged} of {len(blocks)} lines unconfirmed, to be hand-checked against {d['pdf']} page {d['pages'][0]}", "blocks": blocks}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        md = [f"# {d['doc']}", "", f"<!-- consensus golden, reference {ref}; lines marked (?) had no agreeing transcription and need a hand check -->", ""]
        md += [("" if b["agreed"] else "(?) ") + b["text"] for b in blocks]
        (out / f"{d['doc']}.md").write_text("\n".join(md) + "\n", encoding="utf-8")
        n += 1
    return n
