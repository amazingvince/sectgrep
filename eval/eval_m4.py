"""Milestone-4 evaluation: `sect search` quality per E.1 type on the fixture question set (three modes),
and latency on the converted eCFR titles (50 queries, release binary, p95 must be under 1 s).

Run from the repository root (the converted corpus comes from `packages/sect-convert`, see README):
  uv run --project proto python eval/eval_m4.py
Writes eval/results/m4.md. Exit 0 when the fixture run completes and the real-title p95 is under 1 s.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "corpus"
REAL = ROOT / "corpora" / "ecfr"
QDIR = ROOT / "eval" / "questions"
OUT = ROOT / "eval" / "results" / "m4.md"
RETRIEVAL_TYPES = ["locate", "id-lookup", "definition", "cross-ref", "overlay", "table", "negative", "amendment-history"]


def rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()] if path.exists() else []


def recall_at_k(gold: list[str], ranked: list[str], k: int) -> float:
    return sum(1 for g in gold if g in ranked[:k]) / len(gold) if gold else 0.0


def ndcg_at_k(gold: list[str], ranked: list[str], k: int) -> float:
    if not gold:
        return 0.0
    dcg = sum(1 / math.log2(i + 2) for i, r in enumerate(ranked[:k]) if r in gold)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(gold), k)))
    return dcg / idcg if idcg else 0.0


class Sect:
    def __init__(self, exe: Path):
        self.exe = exe
        self.latency: dict[str, list[float]] = defaultdict(list)

    def run(self, corpus: Path, *args: str, key: str = "search") -> tuple[int, dict | None, float]:
        t0 = time.perf_counter()
        p = subprocess.run([str(self.exe), "--corpus", str(corpus), *args, "--json"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        ms = (time.perf_counter() - t0) * 1000
        self.latency[key].append(ms)
        try:
            return p.returncode, json.loads(p.stdout), ms
        except json.JSONDecodeError:
            return p.returncode, None, ms


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:.2f}"


def main() -> int:
    build = subprocess.run(["cargo", "build", "--release", "-p", "sect-cli"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr)
        return 1
    exe = ROOT / "target" / "release" / ("sect.exe" if os.name == "nt" else "sect")
    s = Sect(exe)

    # ---- fixture: quality per type in three modes ---------------------------------------------
    shutil.rmtree(FIXTURE / ".sect", ignore_errors=True)
    code, _, build_ms = s.run(FIXTURE, "index", "--full", key="index-fixture")
    assert code == 0, "fixture index failed"
    questions: list[dict] = []
    filt = QDIR / "crossref.filtered.jsonl"
    for f in sorted(QDIR.glob("*.jsonl")):
        if f.name == "crossref.jsonl" and filt.exists():
            continue
        questions.extend(rows(f))
    per: dict[str, dict[str, list[tuple[float, float]]]] = {m: defaultdict(list) for m in ("fuse", "fts", "vector")}
    per_all_xref: dict[str, list[tuple[float, float]]] = defaultdict(list)
    failures: list[tuple[str, str, str, str]] = []
    for q in questions:
        typ = q["type"]
        gold = q.get("gold") or []
        if typ not in RETRIEVAL_TYPES or not gold:
            continue
        kept = not (typ == "cross-ref" and q.get("filter") and not q["filter"]["kept"])
        for mode in ("fuse", "fts", "vector"):
            flag = [] if mode == "fuse" else [f"--{mode}"]
            args = ["search", q["query"], "--limit", "10", *flag] + (["--as-of", q["as_of"]] if q.get("as_of") else [])
            code, r, _ = s.run(FIXTURE, *args, key=f"search-fixture-{mode}")
            ranked = [h["id"] for h in (r or {}).get("result", {}).get("hits", [])] if code == 0 else []
            rec = (recall_at_k(gold, ranked, 5), ndcg_at_k(gold, ranked, 10))
            if typ == "cross-ref":
                if mode == "fuse":
                    per_all_xref["all"].append(rec)
                if not kept:
                    continue
            per[mode][typ].append(rec)
            if mode == "fuse" and rec[0] < 1.0:
                failures.append((q["qid"], typ, q["query"][:70], ", ".join(ranked[:5])))

    # ---- real titles: 50 queries, latency ----------------------------------------------------
    real_ok = REAL.exists() and (REAL / "cfr-title-1").exists()
    real_lat: list[float] = []
    real_hits: list[tuple[str, str]] = []
    real_meta = ""
    if real_ok:
        code, st, _ = s.run(REAL, "status", key="status-real")
        if code != 0 or not st:
            code, _, ms = s.run(REAL, "index", "--full", key="index-real")
            assert code == 0
            code, st, _ = s.run(REAL, "status", key="status-real")
        stres = st["result"]
        real_meta = f"{stres['files']} files, {stres['works']} Works, {stres['chunks']} chunks, embedding {stres.get('embedding')}"
        for q in rows(QDIR / "ecfr" / "title1-queries.jsonl"):
            code, r, ms = s.run(REAL, "search", q["query"], "--limit", "5", key="search-real")
            real_lat.append(ms)
            top = (r or {}).get("result", {}).get("hits", [])
            real_hits.append((q["query"], f"{top[0]['id']} {top[0]['title']}" if top else "(no hit)"))

    def summary(mode: str) -> dict[str, tuple[int, float, float]]:
        return {t: (len(v), statistics.mean(x[0] for x in v), statistics.mean(x[1] for x in v)) for t, v in per[mode].items()}

    fuse, fts, vec = summary("fuse"), summary("fts"), summary("vector")
    p95 = sorted(real_lat)[min(len(real_lat) - 1, round(0.95 * (len(real_lat) - 1)))] if real_lat else None
    p50 = statistics.median(real_lat) if real_lat else None
    passed = bool(fuse) and (p95 is not None and p95 < 1000)

    L = ["# Milestone 4 results: lexical + semantic `search` (tantivy + model2vec, RRF k=60)\n",
         f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}; release `sect`; every call spawns the binary (model load included).\n",
         "Command: `uv run --project proto python eval/eval_m4.py`\n",
         "## Gates\n", "| Gate (GOAL.md G-G) | Threshold | Measured | Result |", "|---|---|---|---|",
         f"| `sect search` p95 on the converted eCFR titles, 50 queries | < 1000 ms | {pct(p95)} ms (p50 {pct(p50)} ms) | {'PASS' if p95 is not None and p95 < 1000 else 'FAIL'} |",
         f"| Recall@5 and NDCG@10 per E.1 type recorded | yes | {len(fuse)} types | {'PASS' if fuse else 'FAIL'} |",
         f"\n**Overall: {'PASS' if passed else 'FAIL'}.** E.1 quality gates (Recall@5 >= 0.90 locate/definition, exact-match >= 0.95, abstention >= 0.90) are milestone 5's; the numbers here are the milestone-4 baseline for it.\n",
         "## Fixture question set: Recall@5 / NDCG@10 per type and mode\n",
         "Modes: fuse = BM25 top-100 + vector top-100 fused with RRF k=60 (default); fts = BM25 only; vector = model2vec only. Cross-ref is scored on the questions that survived the CRAwLeR filter (`all` = every author-written cross-ref question, fuse mode).\n",
         "| Type | n | fuse R@5 | fuse NDCG@10 | fts R@5 | fts NDCG@10 | vector R@5 | vector NDCG@10 |", "|---|---|---|---|---|---|---|---|"]
    for t in RETRIEVAL_TYPES:
        if t in fuse:
            n, r, nd = fuse[t]
            L.append(f"| {t} | {n} | {r:.2f} | {nd:.2f} | {fts.get(t, (0, 0, 0))[1]:.2f} | {fts.get(t, (0, 0, 0))[2]:.2f} | {vec.get(t, (0, 0, 0))[1]:.2f} | {vec.get(t, (0, 0, 0))[2]:.2f} |")
    if per_all_xref["all"]:
        v = per_all_xref["all"]
        L.append(f"| cross-ref (all {len(v)}, before filter) | {len(v)} | {statistics.mean(x[0] for x in v):.2f} | {statistics.mean(x[1] for x in v):.2f} | | | | |")
    L.append(f"\nFixture index build (release, with embeddings): {build_ms:.0f} ms.\n")
    L.append("## Converted eCFR titles (C1, eCFR XML path): latency of 50 queries\n")
    if real_ok:
        L.append(f"Corpus `corpora/ecfr`: {real_meta}. Queries: `eval/questions/ecfr/title1-queries.jsonl`.\n")
        L.append("| Metric | ms |")
        L.append("|---|---|")
        L.append(f"| p50 | {pct(p50)} |")
        L.append(f"| p95 | {pct(p95)} |")
        L.append(f"| max | {pct(max(real_lat) if real_lat else None)} |")
        L.append("\nTop hit per query (for a human to eyeball; the real-title question set with gold labels is milestone-5 work):\n")
        L.append("| Query | Top hit |")
        L.append("|---|---|")
        for q, h in real_hits:
            L.append(f"| {q} | {h} |")
    else:
        L.append("Converted corpus not found; run the converter first (see README).\n")
    L.append("\n## Fixture failures in fuse mode (Recall@5 < 1)\n")
    if failures:
        L.append("| qid | type | query | top-5 |")
        L.append("|---|---|---|---|")
        for f in failures:
            L.append(f"| {f[0]} | {f[1]} | {f[2]} | {f[3]} |")
    else:
        L.append("None.\n")
    L.append("\n## Latency by call (ms, process start-up included)\n")
    L.append("| Call | n | p50 | p95 |")
    L.append("|---|---|---|---|")
    for k, xs in sorted(s.latency.items()):
        xs2 = sorted(xs)
        L.append(f"| {k} | {len(xs)} | {statistics.median(xs2):.0f} | {xs2[min(len(xs2) - 1, round(0.95 * (len(xs2) - 1)))]:.0f} |")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L[:9]))
    print(f"... wrote {OUT}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
