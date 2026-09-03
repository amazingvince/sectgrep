"""Milestone-5 evaluation: the E.1 gates over the question set (spec E.1), driven through the release
`sect` binary with --json, plus latency p50/p95 per verb and the converted eCFR Title 1 as a second corpus.

Run from the repository root:  uv run --project proto python eval/eval_m5.py
Writes eval/results/m5.md. Exit 0 when every gate passes.

Gates (spec E.1): Recall@5 >= 0.90 on locate and definition; exact-match >= 0.95 on id-lookup, refs,
as-of, and map --complete; abstention accuracy >= 0.90 on no-gold.
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
OUT = ROOT / "eval" / "results" / "m5.md"
GATES = {"locate": 0.90, "definition": 0.90, "id-lookup": 0.95, "refs": 0.95, "as-of": 0.95, "map --complete": 0.95, "no-gold": 0.90}


def rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()] if path.exists() else []


def recall_at_k(gold, ranked, k):
    return sum(1 for g in gold if g in ranked[:k]) / len(gold) if gold else 0.0


def ndcg_at_k(gold, ranked, k):
    if not gold:
        return 0.0
    dcg = sum(1 / math.log2(i + 2) for i, r in enumerate(ranked[:k]) if r in gold)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(gold), k)))
    return dcg / idcg if idcg else 0.0


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def pct(x):
    return "n/a" if x is None else f"{x:.2f}"


class Sect:
    def __init__(self, exe: Path):
        self.exe = exe
        self.latency: dict[str, list[float]] = defaultdict(list)

    def run(self, corpus: Path, *args: str, key: str | None = None):
        t0 = time.perf_counter()
        p = subprocess.run([str(self.exe), "--corpus", str(corpus), *args, "--json"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        ms = (time.perf_counter() - t0) * 1000
        self.latency[key or args[0]].append(ms)
        try:
            return p.returncode, json.loads(p.stdout)
        except json.JSONDecodeError:
            return p.returncode, None


def main() -> int:
    build = subprocess.run(["cargo", "build", "--release", "-p", "sect-cli"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr)
        return 1
    exe = ROOT / "target" / "release" / ("sect.exe" if os.name == "nt" else "sect")
    s = Sect(exe)
    shutil.rmtree(FIXTURE / ".sect", ignore_errors=True)
    code, _ = s.run(FIXTURE, "index", "--full", key="index")
    assert code == 0, "fixture index failed"

    metrics: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    failures: list[tuple[str, str, str, str]] = []

    def note(typ: str, qid: str, ok: bool, detail: str, **vals):
        for k, v in vals.items():
            metrics[typ][k].append(v)
        if not ok:
            failures.append((typ, qid, detail[:80], ""))

    def search_ids(corpus, query, *extra):
        code, r = s.run(corpus, "search", query, "--limit", "10", *extra)
        hits = (r or {}).get("result", {}).get("hits", []) if code == 0 else []
        res = (r or {}).get("result", {})
        return [h["id"] for h in hits], hits, res

    filt = QDIR / "crossref.filtered.jsonl"
    files = [f for f in sorted(QDIR.glob("*.jsonl")) if not (f.name == "crossref.jsonl" and filt.exists())]
    for f in files:
        for q in rows(f):
            typ, qid, gold, exp = q["type"], q["qid"], q.get("gold") or [], q.get("expected") or {}
            if typ in ("locate", "definition", "table", "negative", "overlay", "cross-ref", "amendment-history") and gold:
                extra = ["--as-of", q["as_of"]] if q.get("as_of") else []
                if typ == "cross-ref":
                    extra += ["--expand", "refs"]
                ranked, hits, res = search_ids(FIXTURE, q["query"], *extra)
                r5, nd = recall_at_k(gold, ranked, 5), ndcg_at_k(gold, ranked, 10)
                kept = not (typ == "cross-ref" and q.get("filter") and not q["filter"]["kept"])
                vals = {"recall5": r5, "ndcg10": nd, "false_abstain": float(res.get("abstained", False))}
                if typ == "definition":
                    vals["exact"] = float(bool(hits) and hits[0]["id"] == gold[0] and (not exp.get("anchor") or hits[0].get("anchor") == exp["anchor"]))
                if typ == "negative":
                    bad = set(q.get("must_not_top", []))
                    vals["exact"] = float(bool(hits) and hits[0]["expr"] not in bad and hits[0]["id"] not in bad)
                if typ == "cross-ref":
                    need = set(gold) | set(q.get("context_required", []))
                    got = set(ranked[:5]) | {e["id"] for h in hits[:5] for e in h.get("expanded", [])}
                    vals["context_recall5"] = len(need & got) / len(need)
                    note("cross-ref (all, before filter)", qid, r5 == 1.0, q["query"], **vals)
                    if not kept:
                        continue
                if typ == "overlay" and exp.get("op") == "overlay":
                    code, r = s.run(FIXTURE, "read", exp["id"])
                    st = {"overridden_by": r["result"]["overridden_by"], "narrowed_by": r["result"]["narrowed_by"]} if code == 0 else {}
                    vals["exact"] = float(st == exp["expected"])
                if typ == "table" and exp.get("op") == "table_lookup":
                    code, r = s.run(FIXTURE, "read", exp["id"], "--tables")
                    rws = [x for t in r["result"]["tables"] for x in t["flat_rows"]] if code == 0 else []
                    row = next((x for x in rws if all(c.lower() in x.lower() for c in exp["row_contains"])), None)
                    vals["exact"] = float(row is not None and exp["value"].lower() in row.lower())
                if typ == "amendment-history" and exp.get("op"):
                    continue  # scored below as a structural op
                note(typ, qid, r5 == 1.0, q["query"], **vals)
            if typ == "id-lookup":
                ranked, hits, res = search_ids(FIXTURE, q["query"])
                ok = bool(hits) and hits[0]["id"] == gold[0] and (not exp.get("anchor") or hits[0].get("anchor") == exp["anchor"])
                note(typ, qid, ok, q["query"], exact=float(ok), recall5=recall_at_k(gold, ranked, 5), ndcg10=ndcg_at_k(gold, ranked, 10))
            if typ in ("no-gold", "wrong-corpus"):
                _, _, res = search_ids(FIXTURE, q["query"])
                ok = bool(res.get("abstained"))
                note(typ, qid, ok, q["query"], exact=float(ok))
            op = exp.get("op")
            if op == "map_complete":
                scope = f"{exp['id']}#{exp['anchor']}" if exp.get("anchor") else exp["id"]
                code, r = s.run(FIXTURE, "map", "--complete", "--scope", scope)
                got = [x.get("anchor") or x["id"] for x in r["result"]["entries"]] if code == 0 else []
                note("map --complete", qid, got == exp["expected"], q["query"], exact=float(got == exp["expected"]))
            elif op == "as_of":
                code, r = s.run(FIXTURE, "read", exp["id"], "--as-of", exp["date"])
                got = r["result"]["expr"] if code == 0 and r else None
                note("as-of", qid, got == exp["expected"], q["query"], exact=float(got == exp["expected"]))
            elif op == "as_of_search":
                # The as-of guarantee is which Expression a Work resolves to on the date; rank order
                # among Works is ranking. So: the hit for the expected Work carries the expected Expression.
                _, hits, res = search_ids(FIXTURE, q["query"], "--as-of", exp["date"])
                work = exp["expected"].split("@")[0]
                got = next((h["expr"] for h in hits if h["id"] == work), None) if not res.get("abstained") else None
                note("as-of", qid, got == exp["expected"], q["query"], exact=float(got == exp["expected"]))
            elif op == "history":
                code, r = s.run(FIXTURE, "read", exp["id"], "--history")
                got = [h["id"] for h in r["result"]["history"]] if code == 0 else []
                note("amendment-history", qid, got == exp["expected"], q["query"], exact=float(got == exp["expected"]))
            elif op == "refs":
                args = [exp["id"], "--direction", exp.get("direction", "out"), "--depth", str(exp.get("depth", 1))] + (["--type", exp["type"]] if exp.get("type") else []) + (["--as-of", exp["as_of"]] if exp.get("as_of") else [])
                code, r = s.run(FIXTURE, "refs", *args)
                got = sorted({h["other"] for h in r["result"]["hits"]}) if code == 0 else []
                ok = got == sorted(set(exp["expected"]))
                note("refs", qid, ok, q["query"], exact=float(ok))
            elif op == "define":
                args = [exp["term"], "--usages"] + (["--scope", q["scope"]] if q.get("scope") else [])
                code, r = s.run(FIXTURE, "define", *args)
                res = (r or {}).get("result", {})
                ok = code == 0 and bool(res.get("defined")) and [res.get("id"), res.get("anchor")] == exp["expected"]
                if "usages" in q:
                    ok = ok and sorted(u["id"] for u in res.get("usages", [])) == sorted(q["usages"])
                note("define", qid, bool(ok), q["query"], exact=float(bool(ok)))

    # Other verbs for the latency table.
    for args in (["grep", "-c", "employer"], ["status"], ["map", "--scope", "CFR:99-2"], ["read", "CFR:99-2.7", "--history"], ["search", "fall protection", "--seed", "--budget", "400"]):
        for _ in range(5):
            s.run(FIXTURE, *args, key=" ".join(args[:1] + [a for a in args[1:] if a.startswith("--seed")]))

    # Converted Title 1: the 50 queries with their expected sections as gold.
    real: dict[str, list] = defaultdict(list)
    real_fail: list[tuple[str, str, str]] = []
    real_ok = (REAL / "cfr-title-1").exists()
    if real_ok:
        code, st = s.run(REAL, "status", key="status-real")
        if code != 0:
            s.run(REAL, "index", key="index-real")
        for q in rows(QDIR / "ecfr" / "title1-queries.jsonl"):
            ranked, hits, res = search_ids(REAL, q["query"])
            s.latency["search-title1"].append(s.latency["search"].pop())
            gold = q["expected"]
            r5 = recall_at_k(gold, ranked, 5)
            real[q["type"]].append((r5, ndcg_at_k(gold, ranked, 10), float(res.get("abstained", False))))
            if r5 < 1.0:
                real_fail.append((q["qid"], q["query"][:60], ", ".join(ranked[:3])))

    def m(typ, key):
        return mean(metrics[typ][key]) if typ in metrics else None

    gate_rows = [
        ("Recall@5 locate", GATES["locate"], m("locate", "recall5")),
        ("Recall@5 definition", GATES["definition"], m("definition", "recall5")),
        ("Exact-match id-lookup", GATES["id-lookup"], m("id-lookup", "exact")),
        ("Exact-match refs", GATES["refs"], m("refs", "exact")),
        ("Exact-match as-of", GATES["as-of"], m("as-of", "exact")),
        ("Exact-match map --complete", GATES["map --complete"], m("map --complete", "exact")),
        ("Abstention accuracy no-gold", GATES["no-gold"], m("no-gold", "exact")),
    ]
    passed = all(v is not None and v >= t for _, t, v in gate_rows)

    def lat(xs):
        xs = sorted(xs)
        return f"{statistics.median(xs):.0f} | {xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))]:.0f}"

    L = ["# Milestone 5 results: rank signals, short-circuits, --expand, --seed, abstention; the E.1 gates\n",
         f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}; release `sect`; every call spawns the binary with `--json` (model load included).\n",
         "Command: `uv run --project proto python eval/eval_m5.py` (exit 0 = every gate passed)\n",
         "## Gates (spec E.1, on the milestone-0 question set over `fixtures/corpus`)\n",
         "| Gate | Threshold | Measured | Result |", "|---|---|---|---|"]
    for name, t, v in gate_rows:
        L.append(f"| {name} | >= {t:.2f} | {pct(v)} | {'PASS' if v is not None and v >= t else 'FAIL'} |")
    L.append(f"\n**Overall: {'PASS' if passed else 'FAIL'}.**\n")
    L.append("## Every type\n")
    L.append("| Type | n | Recall@5 | NDCG@10 | Exact-match | Context Recall@5 (--expand refs) | False abstention |")
    L.append("|---|---|---|---|---|---|---|")
    for typ in ["locate", "id-lookup", "definition", "cross-ref", "cross-ref (all, before filter)", "table", "overlay", "negative", "amendment-history", "map --complete", "as-of", "refs", "define", "no-gold", "wrong-corpus"]:
        if typ in metrics:
            n = max(len(v) for v in metrics[typ].values())
            L.append(f"| {typ} | {n} | {pct(m(typ, 'recall5'))} | {pct(m(typ, 'ndcg10'))} | {pct(m(typ, 'exact'))} | {pct(m(typ, 'context_recall5'))} | {pct(m(typ, 'false_abstain'))} |")
    L.append("\nSignals in force (spec B.4): citation short-circuit, definition resolution, adaptive lexical weight x2 for id/term-like queries, title/path +0.10 scaled by the fraction of query terms matched, section coherence +0.10 at 3 or more chunks, hub boost log(1+refs_in)x0.02 capped at 0.10, notes -0.2, superseded filtered at as-of or -0.5 with --include-superseded; abstention when lexical overlap < 0.34 and cosine < 0.30, or cosine < 0.22.\n")
    L.append("## Converted eCFR Title 1 (50 queries, expected section as gold)\n")
    if real_ok:
        L.append("| Type | n | Recall@5 | NDCG@10 | Abstained |")
        L.append("|---|---|---|---|---|")
        for typ, v in real.items():
            L.append(f"| {typ} | {len(v)} | {statistics.mean(x[0] for x in v):.2f} | {statistics.mean(x[1] for x in v):.2f} | {statistics.mean(x[2] for x in v):.2f} |")
        if real_fail:
            L.append("\nMisses (gold not in the top 5):\n")
            L.append("| qid | query | top-3 |")
            L.append("|---|---|---|")
            for f in real_fail:
                L.append(f"| {f[0]} | {f[1]} | {f[2]} |")
    else:
        L.append("Converted corpus not found; see README for the converter.\n")
    L.append("\n## Latency per verb (ms, process start-up included)\n")
    L.append("| Verb | n | p50 | p95 |")
    L.append("|---|---|---|---|")
    for k, xs in sorted(s.latency.items()):
        L.append(f"| {k} | {len(xs)} | {lat(xs)} |")
    L.append("\n## Failures on the fixture\n")
    if failures:
        L.append("| Type | qid | query |")
        L.append("|---|---|---|")
        for f in failures:
            L.append(f"| {f[0]} | {f[1]} | {f[2]} |")
    else:
        L.append("None.\n")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L[:14]))
    print(f"... wrote {OUT}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
