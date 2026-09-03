"""Milestone-3b benchmark: the sparse n-gram prefilter against brute force on the three-title
corpus (Titles 1, 4, 29 as converted into corpora/ecfr), 36 typical agent regexes, five runs each,
medians. Also on the fixture and, with --scaled N, on N stacked copies of the three titles (see
eval/scale_corpus.py) to show the behaviour near the 200 MB auto threshold.

  uv run --project proto python eval/eval_m3b.py [--scaled 10]

Writes eval/results/m3b.md. Exit 0 when the median in-process speedup on the three-title corpus is
at least 5x (the GOAL.md gate), 1 otherwise. Correctness is checked on every query: total matches and
per-file counts must agree between the two modes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "eval" / "results" / "m3b.md"

QUERIES: list[list[str]] = [
    ["guardrail"], ["-i", "guardrail"], ["\\bcage\\b"], ["top rail"], ["42 inches"], ["1926\\.501"], ["§ 1926\\.502"],
    ["respirator"], ["fall protection"], ["employer shall"], ["personal protective equipment"], ["\\bPPE\\b"], ["toe ?board"],
    ["employ(er|ee)s?"], ["\\d+ feet"], ["(?i)scaffold"], ["training"], ["competent person"], ["qualified person"],
    ["hazard communication"], ["Federal Register"], ["Office of the Federal Register"], ["certif(y|ied|ication)"], ["29 CFR"],
    ["part 1910"], ["subpart [A-Z]\\b"], ["\\(a\\)\\(1\\)"], ["effective date"], ["shall not"], ["medical (examination|surveillance)"],
    ["[Ll]adder"], ["asbestos|lead|silica"], ["minimum wage"], ["child labor"], ["\\bOSHA\\b"], ["not less than \\d+"],
]


def run(exe: Path, corpus: Path, args: list[str]) -> tuple[dict, float]:
    t0 = time.perf_counter()
    p = subprocess.run([str(exe), "--corpus", str(corpus), "grep", "--json", "--max-hits", "100000", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    wall = (time.perf_counter() - t0) * 1000
    if p.returncode != 0:
        raise SystemExit(f"grep failed for {args}: {p.stderr}")
    return json.loads(p.stdout), wall


def index(exe: Path, corpus: Path, ngram: str) -> dict:
    p = subprocess.run([str(exe), "--corpus", str(corpus), "index", "--ngram", ngram, "--json"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        raise SystemExit(f"index failed for {corpus} (exit {p.returncode}): {p.stderr} {p.stdout[:2000]}")
    return json.loads(p.stdout)


def bench(exe: Path, corpus: Path, name: str, reps: int = 5) -> dict:
    rep = index(exe, corpus, "on")
    ngram_dir = corpus / ".sect" / "ngram"
    size = sum(f.stat().st_size for f in ngram_dir.iterdir()) if ngram_dir.exists() else 0
    rows = []
    for q in QUERIES:
        inproc_on, inproc_off, wall_on, wall_off = [], [], [], []
        first_on = first_off = None
        for _ in range(reps):
            on, w_on = run(exe, corpus, q)
            off, w_off = run(exe, corpus, [*q, "--no-index"])
            first_on, first_off = first_on or on, first_off or off
            pf = on["result"].get("prefilter") or {}
            inproc_on.append(on["result"]["scan_ms"] + (pf.get("elapsed_ms") or 0.0))
            inproc_off.append(off["result"]["scan_ms"])
            wall_on.append(w_on)
            wall_off.append(w_off)
        same = first_on["result"]["total_matches"] == first_off["result"]["total_matches"] and first_on["result"]["per_file"] == first_off["result"]["per_file"]
        pf = first_on["result"].get("prefilter") or {}
        rows.append({
            "query": " ".join(q), "matches": first_off["result"]["total_matches"], "files_matched": first_off["result"]["files_matched"],
            "candidates": pf.get("candidate_count"), "files_total": pf.get("files_total"), "fallback": pf.get("candidate_count") is None,
            "reason": pf.get("reason", ""), "on_ms": statistics.median(inproc_on), "off_ms": statistics.median(inproc_off),
            "wall_on": statistics.median(wall_on), "wall_off": statistics.median(wall_off), "same": same,
        })
    for r in rows:
        r["speedup"] = r["off_ms"] / r["on_ms"] if r["on_ms"] > 0 else float("inf")
        r["wall_speedup"] = r["wall_off"] / r["wall_on"] if r["wall_on"] > 0 else float("inf")
    return {"name": name, "files": rep["files"], "rows": rows, "index_bytes": size, "layer_ms": rep["layer_ms"].get("ngram"), "corpus_bytes": sum(f.stat().st_size for f in corpus.rglob("*.md"))}


def summarize(b: dict) -> dict:
    rows = b["rows"]
    return {
        "median_speedup": statistics.median(r["speedup"] for r in rows),
        "median_wall_speedup": statistics.median(r["wall_speedup"] for r in rows),
        "fallbacks": sum(1 for r in rows if r["fallback"]),
        "all_same": all(r["same"] for r in rows),
        "median_off_ms": statistics.median(r["off_ms"] for r in rows),
        "median_on_ms": statistics.median(r["on_ms"] for r in rows),
        "median_wall_off": statistics.median(r["wall_off"] for r in rows),
        "median_wall_on": statistics.median(r["wall_on"] for r in rows),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scaled", type=int, default=0, help="also benchmark N stacked copies of the three titles")
    ap.add_argument("--reps", type=int, default=5)
    a = ap.parse_args()
    build = subprocess.run(["cargo", "build", "--release", "-p", "sect-cli"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr)
        return 1
    exe = ROOT / "target" / "release" / ("sect.exe" if os.name == "nt" else "sect")
    real = ROOT / "corpora" / "ecfr"
    if not (real / "cfr-title-29").is_dir():
        raise SystemExit("corpora/ecfr must hold Titles 1, 4 and 29 (see README, converter)")
    results = [bench(exe, ROOT / "fixtures" / "corpus", "fixture (44 files)", a.reps), bench(exe, real, "three titles: 1, 4, 29", a.reps)]
    if a.scaled:
        scaled = ROOT / "corpora" / "scaled"
        subprocess.run([sys.executable, str(ROOT / "eval" / "scale_corpus.py"), "--copies", str(a.scaled), "--src", str(real), "--out", str(scaled)], check=True)
        results.append(bench(exe, scaled, f"{a.scaled} stacked copies of the three titles", a.reps))
    # Leave the corpora as they were: the layer comes back only under auto above the threshold.
    for c in [ROOT / "fixtures" / "corpus", real]:
        index(exe, c, "auto")
    gate = summarize(results[1])
    passed = gate["median_speedup"] >= 5.0 and gate["all_same"]
    L = [
        "# Milestone 3b results: sparse n-gram prefilter for grep (spec B.4)\n",
        f"Generated {dt.datetime.now().isoformat(timespec='seconds')}; release `sect`, {a.reps} runs per query per mode, medians. In-process time is the prefilter plus the matcher scan as reported by `grep --json`; wall time includes process start-up and the freshness stat pass. Every query's total matches and per-file counts were compared between the two modes.\n",
        "Command: `uv run --project proto python eval/eval_m3b.py --scaled 10` (exit 0 = median in-process speedup >= 5x on the three-title corpus, the GOAL.md gate).\n",
        "## Gate\n",
        "| Corpus | Files | Corpus MB | Index MB | Layer build | Fallbacks | Median in-process (scan / prefiltered) | Median in-process speedup | Median wall (scan / prefiltered) | Median wall speedup | Outputs identical |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for b in results:
        s = summarize(b)
        L.append(f"| {b['name']} | {b['files']} | {b['corpus_bytes'] / 1e6:.1f} | {b['index_bytes'] / 1e6:.1f} | {b['layer_ms']} ms | {s['fallbacks']} of {len(b['rows'])} | {s['median_off_ms']:.1f} / {s['median_on_ms']:.1f} ms | **{s['median_speedup']:.1f}x** | {s['median_wall_off']:.0f} / {s['median_wall_on']:.0f} ms | {s['median_wall_speedup']:.1f}x | {'yes' if s['all_same'] else 'NO'} |")
    L.append(f"\n**Gate (three titles, median in-process speedup >= 5x): {'PASS' if passed else 'FAIL'} ({gate['median_speedup']:.1f}x).**\n")
    for b in results:
        L.append(f"## {b['name']}\n")
        L.append("| Query | Matches | Files matched | Candidates / files | Scan ms | Prefiltered ms | Speedup | Wall scan / prefiltered ms | Wall speedup | Note |")
        L.append("|---|---|---|---|---|---|---|---|---|---|")
        for r in b["rows"]:
            cand = "full scan" if r["fallback"] else f"{r['candidates']} / {r['files_total']}"
            note = r["reason"] if r["fallback"] else ("" if r["same"] else "OUTPUT DIFFERS")
            L.append(f"| `{r['query']}` | {r['matches']} | {r['files_matched']} | {cand} | {r['off_ms']:.1f} | {r['on_ms']:.1f} | {r['speedup']:.1f}x | {r['wall_off']:.0f} / {r['wall_on']:.0f} | {r['wall_speedup']:.1f}x | {note} |")
        L.append("")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L[:12]))
    print(f"... wrote {OUT}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
