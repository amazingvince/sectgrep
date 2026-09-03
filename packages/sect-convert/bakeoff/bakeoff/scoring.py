"""Score every (arm, doc) pair that has an output under raw/bakeoff/work/."""

from __future__ import annotations

import json
from pathlib import Path

from .manifest import RAW, ROOT
from .score import clip_to_section, reading_order, strip_front_matter, teds_for_doc, text_edit

WORK = RAW / "work"


def arm_names() -> list[str]:
    return sorted(p.name for p in WORK.iterdir() if p.is_dir() and any(p.glob("*.md")))


def score_one(arm: str, doc: dict) -> dict | None:
    md_path = WORK / arm / f"{doc['doc']}.md"
    if not md_path.exists():
        return None
    golden_path = ROOT / doc["golden"]
    if not golden_path.exists():
        return None
    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    gold_lines = [b["text"] for b in golden["blocks"] if b["kind"] != "table" and b["text"]]
    gold_tables = [b["html"] for b in golden["blocks"] if b["kind"] == "table"]
    raw = md_path.read_text(encoding="utf-8")
    pred = strip_front_matter(raw)
    pred = clip_to_section(pred, doc.get("section"))
    meta = json.loads((WORK / arm / f"{doc['doc']}.json").read_text(encoding="utf-8")) if (WORK / arm / f"{doc['doc']}.json").exists() else {}
    elapsed = meta.get("elapsed_s") or sum(p.get("elapsed_s", 0) for p in meta.get("pages", []))
    ro = reading_order(pred, gold_lines)
    row = {
        "arm": arm, "doc": doc["doc"], "group": doc["group"], "pages": len(doc["pages"]),
        "text_edit": round(text_edit(pred, gold_lines), 4),
        "read_order": round(ro.distance, 4), "block_miss": round(ro.miss_rate, 4),
        "teds": None, "elapsed_s": round(elapsed, 2) if elapsed else None, "chars": len(pred), "empty": len(raw.strip()) == 0,
        "rc": meta.get("rc"),
    }
    if gold_tables:
        scores = teds_for_doc(raw, gold_tables)
        row["teds"] = round(sum(scores) / len(scores), 4)
        row["tables_found"] = sum(1 for s in scores if s > 0)
        row["tables_gold"] = len(gold_tables)
    return row


def score_all(docs: list[dict], only: list[str] | None = None) -> list[dict]:
    rows = []
    for arm in only or arm_names():
        for d in docs:
            r = score_one(arm, d)
            if r:
                rows.append(r)
    return rows
