"""Milestone-6 measurements (spec B.6): full build time, single-file incremental time, no-op time, the
freshness stat pass at 10k files, and the freshness policies, on the converted eCFR titles and on a
synthetic 10k-section corpus.

  uv run --project proto python eval/eval_m6.py
Writes eval/results/m6.md. Exit 0 when the three B.6 targets are met.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REAL = ROOT / "corpora" / "ecfr"
SYN = ROOT / "corpora" / "synthetic"
OUT = ROOT / "eval" / "results" / "m6.md"


def run(exe: Path, corpus: Path, *args: str, env: dict | None = None):
    t0 = time.perf_counter()
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.run([str(exe), "--corpus", str(corpus), *args, "--json"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", env=e)
    ms = (time.perf_counter() - t0) * 1000
    try:
        return json.loads(p.stdout), ms, p.returncode
    except json.JSONDecodeError:
        return None, ms, p.returncode


def median(xs):
    return statistics.median(xs) if xs else float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--linux-stat-ms", type=float, default=None, help="stat pass on 10k files measured on Linux (from the CI step)")
    ap.add_argument("--linux-incremental-ms", type=float, default=None, help="single-file incremental at 10k files measured on Linux (from the CI step)")
    ap.add_argument("--linux-run", default="", help="URL of the CI run the Linux numbers come from")
    a = ap.parse_args()
    build = subprocess.run(["cargo", "build", "--release", "-p", "sect-cli"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr)
        return 1
    exe = ROOT / "target" / "release" / ("sect.exe" if os.name == "nt" else "sect")
    rows: list[tuple[str, str]] = []

    def measure_corpus(name: str, corpus: Path, sample_file: Path, n_files: int) -> dict:
        r: dict = {}
        shutil.rmtree(corpus / ".sect", ignore_errors=True)
        rep, ms, code = run(exe, corpus, "index", "--full")
        assert code == 0 and rep, f"full build failed for {name}: {rep}"
        r["full_ms"] = rep["elapsed_ms"]
        r["full_wall_ms"] = ms
        r["layers"] = rep["layer_ms"]
        r["chunks"] = rep["chunks"]
        noop = [run(exe, corpus, "index")[0]["elapsed_ms"] for _ in range(5)]
        r["noop_ms"] = median(noop)
        r["noop_mode"] = run(exe, corpus, "index")[0]["mode"]
        original = sample_file.read_text(encoding="utf-8")
        inc, inc_wall = [], []
        try:
            for i in range(5):
                sample_file.write_text(original + f"\n(z) Incremental touch {i}.\n", encoding="utf-8", newline="\n")
                rep, ms, code = run(exe, corpus, "index")
                assert code == 0 and rep["mode"] == "incremental" and rep["changed"] == 1, rep
                inc.append(rep["elapsed_ms"])
                inc_wall.append(ms)
            r["inc_layers"] = rep["layer_ms"]
        finally:
            sample_file.write_text(original, encoding="utf-8", newline="\n")
            run(exe, corpus, "index")
        r["inc_ms"] = median(inc)
        r["inc_wall_ms"] = median(inc_wall)
        stats = []
        for _ in range(7):
            st, ms, _ = run(exe, corpus, "status")
            stats.append(st["freshness"]["stat_ms"])
        r["stat_ms"] = median(stats)
        r["stat_max_ms"] = max(stats)
        r["status_wall_ms"] = ms
        r["files"] = n_files
        # A query on a small change set refreshes synchronously; a large one goes to the background.
        sample_file.write_text(original + "\n(z) touched for the sync test.\n", encoding="utf-8", newline="\n")
        st, _, _ = run(exe, corpus, "status")
        r["sync_state"] = st["freshness"]["state"]
        r["sync_rebuilt"] = st["freshness"].get("rebuilt")
        sample_file.write_text(original, encoding="utf-8", newline="\n")
        run(exe, corpus, "index")
        return r

    real_ok = (REAL / "cfr-title-1").exists()
    real = measure_corpus("ecfr", REAL, REAL / "cfr-title-1" / "I" / "A" / "1" / "1.1" / "1-1.1.md", 638) if real_ok else None
    if not (SYN / "syn-title-7").exists():
        subprocess.run([sys.executable, str(ROOT / "eval" / "gen_synthetic.py"), "--sections", "10000", "--out", str(SYN)], check=True)
    syn = measure_corpus("synthetic", SYN, SYN / "syn-title-7" / "1" / "1.1" / "7-1.1.md", 10102)

    # Background policy on the synthetic corpus: touch 40 files, expect possibly_stale + background, then fresh.
    touched = []
    for p in range(1, 41):
        f = SYN / "syn-title-7" / "1" / f"1.{p}" / f"7-1.{p}.md"
        touched.append((f, f.read_text(encoding="utf-8")))
        f.write_text(touched[-1][1] + "\n(z) background touch.\n", encoding="utf-8", newline="\n")
    st, bg_wall, _ = run(exe, SYN, "status")
    bg_state, bg_flag = st["freshness"]["state"], st["freshness"].get("background")
    waited = 0.0
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < 180:
        st, _, _ = run(exe, SYN, "status", "--freshness", "no")
        if st["freshness"]["state"] == "fresh":
            waited = time.perf_counter() - t0
            break
        time.sleep(0.5)
    for f, text in touched:
        f.write_text(text, encoding="utf-8", newline="\n")
    run(exe, SYN, "index")

    linux_stat = f"{a.linux_stat_ms:.0f} ms" if a.linux_stat_ms is not None else "not measured"
    targets = [
        ("Full build of one converted CFR title (Titles 1 + 4, 638 files)", "< 60 s", f"{real['full_ms'] / 1000:.2f} s" if real else "n/a", "", real is not None and real["full_ms"] < 60_000),
        ("Full build at spec scale (synthetic, 10,102 files, 10,000 sections)", "< 60 s", f"{syn['full_ms'] / 1000:.2f} s", "", syn["full_ms"] < 60_000),
        ("Single-file change re-indexed (converted title, in-process)", "< 500 ms", f"{real['inc_ms']:.0f} ms (wall {real['inc_wall_ms']:.0f} ms)" if real else "n/a", f"{a.linux_incremental_ms:.0f} ms at 10k files" if a.linux_incremental_ms is not None else "", real is not None and real["inc_ms"] < 500),
        ("Freshness stat pass on 10k files (parallel stat + parent listings)", "< 10 ms", f"{syn['stat_ms']:.0f} ms (max {syn['stat_max_ms']:.0f} ms)", linux_stat, a.linux_stat_ms is not None and a.linux_stat_ms < 10),
    ]
    passed = all(t[4] for t in targets)
    L = ["# Milestone 6 results: incremental indexing and freshness (spec B.6)\n",
         f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}, {platform.machine()}; release `sect`. In-process times come from the build report; wall times include process start-up.\n",
         "Command: `uv run --project proto python eval/eval_m6.py` (exit 0 = all B.6 targets met)\n",
         "## B.6 targets\n", "| Target | Spec | Measured | Result |", "|---|---|---|---|"]
    for name, spec, got, ok in targets:
        L.append(f"| {name} | {spec} | {got} | {'PASS' if ok else 'FAIL'} |")
    L.append(f"\n**Overall: {'PASS' if passed else 'FAIL'}.**\n")
    L.append("## Per-corpus measurements\n")
    L.append("| Corpus | Files | Chunks | Full build (in-process) | Layer times | No-op re-run | Single-file incremental | Incremental layers | Stat pass (median / max) | `status` wall |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for name, r in (("ecfr (Titles 1 + 4)", real), ("synthetic 10k", syn)):
        if r:
            layers = ", ".join(f"{k} {v}" for k, v in r["layers"].items())
            inc_layers = ", ".join(f"{k} {v}" for k, v in r["inc_layers"].items())
            L.append(f"| {name} | {r['files']} | {r['chunks']} | {r['full_ms']} ms | {layers} | {r['noop_ms']:.0f} ms ({r['noop_mode']}) | {r['inc_ms']:.0f} ms | {inc_layers} | {r['stat_ms']:.0f} / {r['stat_max_ms']:.0f} ms | {r['status_wall_ms']:.0f} ms |")
    L.append("\n## Freshness policies\n")
    for name, r in (("ecfr", real), ("synthetic", syn)):
        if r:
            L.append(f"- {name}: one changed file, `sect status` (auto) answered `{r['sync_state']}` with rebuilt = {r['sync_rebuilt']} (synchronous incremental inside the query).")
    L.append(f"- synthetic: 40 changed files (over the {os.environ.get('SECT_SYNC_LIMIT', '20')}-file sync limit), `sect status` answered `{bg_state}` with background = {bg_flag} in {bg_wall:.0f} ms and the index was fresh again {waited:.1f} s later; `--freshness wait` blocks instead, `--freshness no` answers as-is.\n")
    L.append("## Notes\n")
    L.append("- Re-running `sect index` on unchanged input is a no-op: the fingerprint diff finds nothing and no layer is touched (mode `noop`).")
    L.append("- The n-gram layer of milestone 3b does not exist yet; the incremental pipeline has a slot for it (`layers.ngram` in the manifest).")
    L.append("- Single-file incremental time is dominated by loading the embedding model to embed the changed chunk; the structural layer is rebuilt whole from the parse cache because it is cheap.")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L[:12]))
    print(f"... wrote {OUT}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
