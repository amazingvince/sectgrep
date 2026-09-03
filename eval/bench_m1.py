"""Milestone-1 timings: index build and read/map/status latency of the release `sect` binary on the fixture.

Run from the repository root:  uv run --project proto python eval/bench_m1.py
Writes eval/results/m1.md. Every number includes process start-up (the binary is spawned per call).
"""

from __future__ import annotations

import datetime as dt
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "fixtures" / "corpus"
OUT = ROOT / "eval" / "results" / "m1.md"


def run(args: list[str]) -> tuple[float, subprocess.CompletedProcess]:
    t0 = time.perf_counter()
    p = subprocess.run([str(a) for a in args], cwd=ROOT, capture_output=True, text=True)
    return (time.perf_counter() - t0) * 1000, p


def stats(xs: list[float]) -> str:
    xs = sorted(xs)
    p95 = xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))]
    return f"{statistics.median(xs):.1f} | {p95:.1f} | {xs[0]:.1f}"


def main() -> int:
    build = subprocess.run(["cargo", "build", "--release", "-p", "sect-cli"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr)
        return 1
    exe = ROOT / "target" / "release" / ("sect.exe" if os.name == "nt" else "sect")
    rows: list[tuple[str, list[float]]] = []

    full = []
    for _ in range(5):
        shutil.rmtree(CORPUS / ".sect", ignore_errors=True)
        ms, p = run([exe, "index", "--full", CORPUS])
        assert p.returncode == 0, p.stdout + p.stderr
        full.append(ms)
    rows.append(("`sect index --full` (cold: no fingerprints, all files hashed)", full))
    rows.append(("`sect index` (warm: fingerprints match, structural rebuild)", [run([exe, "index", CORPUS])[0] for _ in range(10)]))
    rows.append(("`sect index --validate-only`", [run([exe, "index", "--validate-only", CORPUS])[0] for _ in range(10)]))
    single = []
    target = CORPUS / "cfr-title-99" / "I" / "A" / "1" / "1.1" / "99-1.1.md"
    original = target.read_text(encoding="utf-8")
    try:
        for i in range(5):
            target.write_text(original + f"\n<!-- bench touch {i} -->\n", encoding="utf-8")
            ms, p = run([exe, "status", "--corpus", CORPUS])
            assert p.returncode == 0 and "rebuilt after 1 changed" in p.stdout, p.stdout + p.stderr
            single.append(ms)
    finally:
        target.write_text(original, encoding="utf-8")
        run([exe, "index", CORPUS])
    rows.append(("single-file change, refreshed inside the next query (`sect status`)", single))
    for name, args in [
        ("`sect status` (fresh; stats 44 files first)", ["status"]),
        ("`sect read CFR:99-2.7`", ["read", "CFR:99-2.7"]),
        ("`sect read CFR:99-2.8 --ancestors --children`", ["read", "CFR:99-2.8", "--ancestors", "--children"]),
        ("`sect map --scope CFR:99-2`", ["map", "--scope", "CFR:99-2"]),
        ("`sect map --depth 5` (whole corpus)", ["map", "--depth", "5"]),
        ("`sect status --json`", ["status", "--json"]),
    ]:
        xs = []
        for _ in range(20):
            ms, p = run([exe, *args, "--corpus", CORPUS])
            assert p.returncode == 0, p.stdout + p.stderr
            xs.append(ms)
        rows.append((name, xs))
    sizes = {f.name: f.stat().st_size for f in sorted((CORPUS / ".sect").iterdir())}
    ver = subprocess.run([str(exe), "--version"], capture_output=True, text=True).stdout.strip()

    L = [
        "# Milestone 1 results: Rust skeleton timings on the fixture corpus\n",
        f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}, {platform.machine()}; "
        f"`{ver}` release build; corpus `fixtures/corpus` (44 files, 43 works, 4 sources). Each row spawns the binary per call, so every figure includes process start-up.\n",
        "Command: `uv run --project proto python eval/bench_m1.py`\n",
        "| Operation | n | p50 ms | p95 ms | min ms |",
        "|---|---|---|---|---|",
    ]
    for name, xs in rows:
        L.append(f"| {name} | {len(xs)} | {stats(xs)} |")
    L.append("\n## Index files under `fixtures/corpus/.sect/`\n")
    L.append("| File | Bytes |")
    L.append("|---|---|")
    for k, v in sizes.items():
        L.append(f"| {k} | {v} |")
    L.append("\n## Against the spec B.6 targets\n")
    L.append("| Target | Spec | Fixture measurement | Status |")
    L.append("|---|---|---|---|")
    L.append(f"| Full build of one CFR title (~5-10k sections) | < 60 s | {statistics.median(full):.0f} ms for 44 files (structural layer only) | on track; re-measure at milestone 4 with a real title and the lexical/semantic layers |")
    L.append(f"| Single-file incremental | < 500 ms | {statistics.median(single):.0f} ms including process start, as a whole structural rebuild | met on the fixture; milestone 6 makes the rebuild incremental |")
    L.append(f"| Freshness stat of the tree | < 10 ms for 10k files | `sect status` on a fresh index takes {statistics.median(rows[4][1]):.0f} ms end to end including start-up; the stat pass is a fraction of that | measure in-process at milestone 6 |")
    L.append("\nAll structural verbs answer from `tree.json` plus the section file itself; no network, no model, no daemon.\n")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
