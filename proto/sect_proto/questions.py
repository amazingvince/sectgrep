"""CRAwLeR-style cross-reference question support (spec E.1).

Recipe: detect explicit cross-references; the referencing section is the target and the
referenced sections are required context; an LLM writes a query that is unanswerable from the
target alone; an adversarial filter removes anything a non-contextual BM25 or vector baseline
solves at rank <= N. The query-writing step is done by the author (an LLM) into
`crossref.jsonl`; this module produces the candidate pairs and runs the filter.
"""

from __future__ import annotations

import json
from pathlib import Path

from .corpus import Corpus
from .index import Searcher


def crossref_candidates(corpus: Corpus) -> list[dict]:
    out = []
    for s in corpus.current.values():
        if s.kind in ("note", "notice") or s.level not in ("section",):
            continue
        refs = sorted({t for t in s.link_targets if t in corpus.current and corpus.current[t].level == "section" and t != s.id})
        if refs:
            out.append({"target": s.id, "title": s.title, "referenced": refs, "query": ""})
    return out


def adversarial_filter(searcher: Searcher, questions: list[dict], rank: int = 10) -> list[dict]:
    """Mark each cross-ref question with the non-contextual baseline ranks and keep those unsolved."""
    out = []
    for q in questions:
        target = q["gold"][0]
        bm = searcher.baseline(q["query"], "bm25")
        vec = searcher.baseline(q["query"], "vector")
        r_bm = bm.index(target) + 1 if target in bm else None
        r_vec = vec.index(target) + 1 if target in vec else None
        solved = (r_bm is not None and r_bm <= rank) or (r_vec is not None and r_vec <= rank)
        out.append({**q, "filter": {"rank_threshold": rank, "baseline_bm25_rank": r_bm, "baseline_vector_rank": r_vec, "kept": not solved}})
    return out


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8", newline="\n")
