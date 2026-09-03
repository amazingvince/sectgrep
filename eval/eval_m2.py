"""Milestone-2 evaluation: exact-match of the structural verbs against eval/questions, driven through
the release `sect` binary with --json, plus latencies and the structural counts from `sect status`.

Run from the repository root:  uv run --project proto python eval/eval_m2.py
Writes eval/results/m2.md. Exit code 0 when refs, define, as-of, and map --complete are all exact-match 1.0.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "fixtures" / "corpus"
QDIR = ROOT / "eval" / "questions"
OUT = ROOT / "eval" / "results" / "m2.md"


def rows(name: str) -> list[dict]:
    return [json.loads(l) for l in (QDIR / name).read_text(encoding="utf-8").splitlines() if l.strip()]


def stats(xs: list[float]) -> str:
    xs = sorted(xs)
    return f"{statistics.median(xs):.1f} | {xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))]:.1f}"


class Sect:
    def __init__(self, exe: Path):
        self.exe = exe
        self.latency: dict[str, list[float]] = {}

    def run(self, verb: str, *args: str) -> tuple[int, dict | None]:
        t0 = time.perf_counter()
        p = subprocess.run([str(self.exe), verb, *args, "--json", "--corpus", str(CORPUS)], cwd=ROOT, capture_output=True, text=True)
        self.latency.setdefault(verb, []).append((time.perf_counter() - t0) * 1000)
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
    code, _ = s.run("index")
    assert code == 0
    results: dict[str, list[tuple[str, bool, str]]] = {}
    skipped: list[str] = []

    for q in rows("subtree.jsonl"):
        e = q["expected"]
        scope = f"{e['id']}#{e['anchor']}" if e.get("anchor") else e["id"]
        _, r = s.run("map", "--complete", "--scope", scope)
        got = [x.get("anchor") or x["id"] for x in r["result"]["entries"]]
        results.setdefault("map --complete", []).append((q["qid"], got == e["expected"], f"{got}"))

    for q in rows("as-of.jsonl"):
        e = q["expected"]
        if e["op"] != "as_of":
            skipped.append(f"{q['qid']} ({e['op']}: needs `search`, milestone 4)")
            continue
        code, r = s.run("read", e["id"], "--as-of", e["date"])
        got = r["result"]["expr"] if code == 0 and r else None
        results.setdefault("read --as-of", []).append((q["qid"], got == e["expected"], f"{got}"))

    for q in rows("amendment-history.jsonl"):
        e = q.get("expected") or {}
        if e.get("op") == "history":
            _, r = s.run("read", e["id"], "--history")
            got = [h["id"] for h in r["result"]["history"]]
            results.setdefault("read --history", []).append((q["qid"], got == e["expected"], f"{got}"))
        elif e.get("op") == "refs":
            results.setdefault("refs", []).append(run_refs(s, q))
        else:
            skipped.append(f"{q['qid']} (retrieval question)")

    for q in rows("refs.jsonl"):
        results.setdefault("refs", []).append(run_refs(s, q))

    for q in rows("define.jsonl"):
        e = q["expected"]
        args = [e["term"], "--usages"] + (["--scope", q["scope"]] if q.get("scope") else [])
        code, r = s.run("define", *args)
        res = r["result"] if r else {}
        ok = code == 0 and res.get("defined") and [res.get("id"), res.get("anchor")] == e["expected"]
        if "usages" in q:
            ok = ok and sorted(u["id"] for u in res.get("usages", [])) == sorted(q["usages"])
        results.setdefault("define", []).append((q["qid"], bool(ok), f"{res.get('id')}#{res.get('anchor')} usages {[u['id'] for u in res.get('usages', [])]}"))

    _, st = s.run("status")
    st = st["result"]
    gates = ["refs", "define", "read --as-of", "map --complete"]
    passed = all(all(ok for _, ok, _ in results.get(g, [])) and results.get(g) for g in gates)

    L = ["# Milestone 2 results: structural verbs on the fixture corpus\n",
         f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}; release `sect`; every call spawns the binary with `--json`.\n",
         "Command: `uv run --project proto python eval/eval_m2.py` (exit 0 = all four gated verbs exact-match 1.0)\n",
         "## Exact-match by verb\n", "| Verb | n | Exact-match | Gate |", "|---|---|---|---|"]
    for verb, recs in results.items():
        em = sum(1 for _, ok, _ in recs) and sum(1 for _, ok, _ in recs if ok) / len(recs)
        L.append(f"| {verb} | {len(recs)} | {em:.2f} | {'PASS' if em == 1.0 else 'FAIL'} |" if verb in gates else f"| {verb} | {len(recs)} | {em:.2f} | n/a |")
    L.append(f"\n**Overall: {'PASS' if passed else 'FAIL'}.** Structural results come from traversal over `xrefs.jsonl`, `actions.jsonl`, `terms.json`, `tables.jsonl`, and `tree.json`; no ranking is involved.\n")
    if skipped:
        L.append("Skipped: " + "; ".join(skipped) + ".\n")
    L.append("## Structure counts (`sect status`)\n")
    L.append(f"- {st['edges']} edges, {st['actions']} Actions, {st['terms']} defined terms, {st['tables']} tables over {st['works']} Works and {st['expressions']} Expressions; unresolved refs: {st['unresolved_refs']}; warnings: {len(st['warnings'])}.\n")
    L.append("## Latency (ms, including process start-up)\n")
    L.append("| Verb | n | p50 | p95 |")
    L.append("|---|---|---|---|")
    for verb, xs in sorted(s.latency.items()):
        L.append(f"| {verb} | {len(xs)} | {stats(xs)} |")
    fails = [(v, qid, d) for v, recs in results.items() for qid, ok, d in recs if not ok]
    L.append("\n## Failures\n")
    if fails:
        L.append("| Verb | qid | got |")
        L.append("|---|---|---|")
        for v, qid, d in fails:
            L.append(f"| {v} | {qid} | {d} |")
    else:
        L.append("None.\n")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L))
    return 0 if passed else 1


def run_refs(s: Sect, q: dict) -> tuple[str, bool, str]:
    e = q["expected"]
    args = [e["id"], "--direction", e.get("direction", "out"), "--depth", str(e.get("depth", 1))]
    if e.get("type"):
        args += ["--type", e["type"]]
    if e.get("as_of"):
        args += ["--as-of", e["as_of"]]
    _, r = s.run("refs", *args)
    got = sorted({h["other"] for h in r["result"]["hits"]}) if r else []
    return q["qid"], got == sorted(set(e["expected"])), f"{got}"


if __name__ == "__main__":
    sys.exit(main())
