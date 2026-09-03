"""Milestone-3 evaluation: `sect grep` parity with ripgrep on the fixture, with timings.

Run from the repository root:
  uv run --project proto python eval/eval_m3.py                 # compare sect grep with rg live and with the goldens
  uv run --project proto python eval/eval_m3.py --update-golden # record rg output as eval/golden/grep/<id>.txt

Writes eval/results/m3.md. Exit 0 when every case matches.
"""

from __future__ import annotations

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
CORPUS = ROOT / "fixtures" / "corpus"
GOLDEN = ROOT / "eval" / "golden" / "grep"
OUT = ROOT / "eval" / "results" / "m3.md"


def normalize(line: str) -> str:
    cut = line.find(".md")
    if cut < 0:
        cut = line.find(".yaml")
    if cut < 0:
        return line
    return line[:cut].replace("\\", "/") + line[cut:]


def run(cmd: list[str], cwd: Path) -> tuple[float, str]:
    t0 = time.perf_counter()
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    return (time.perf_counter() - t0) * 1000, p.stdout


def main() -> int:
    update = "--update-golden" in sys.argv
    rg = os.environ.get("RG") or shutil.which("rg")  # RG=<path to rg.exe> when rg is a shell alias/function
    build = subprocess.run(["cargo", "build", "--release", "-p", "sect-cli"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr)
        return 1
    exe = ROOT / "target" / "release" / ("sect.exe" if os.name == "nt" else "sect")
    subprocess.run([str(exe), "index", str(CORPUS)], cwd=ROOT, capture_output=True)
    rg_version = subprocess.run([rg, "--version"], capture_output=True, text=True).stdout.splitlines()[0] if rg else "not on PATH"
    cases = [json.loads(l) for l in (GOLDEN / "cases.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = []
    t_sect: list[float] = []
    t_rg: list[float] = []
    all_ok = True
    for c in cases:
        args = c["args"]
        ms, out = run([str(exe), "--corpus", str(CORPUS), "grep", *args], ROOT)
        t_sect.append(ms)
        lines = out.splitlines()
        assert lines[0].startswith("freshness: ") and lines[1].startswith("counts: "), out
        got = [l for l in lines[2:] if not l.startswith("note: ")]
        rg_lines = None
        if rg:
            ms_rg, rg_out = run([rg, "--sort", "path", "-n", "--color", "never", *args, *c.get("rg_extra", [])], CORPUS)
            t_rg.append(ms_rg)
            rg_lines = [normalize(l) for l in rg_out.splitlines()]
            if update:
                (GOLDEN / f"{c['id']}.txt").write_text("\n".join(rg_lines) + ("\n" if rg_lines else ""), encoding="utf-8", newline="\n")
        golden_file = GOLDEN / f"{c['id']}.txt"
        golden = golden_file.read_text(encoding="utf-8").splitlines() if golden_file.exists() else None
        ok_golden = golden is not None and got == golden
        ok_live = rg_lines is None or got == rg_lines
        ok = ok_golden and ok_live
        all_ok = all_ok and ok
        rows.append((c["id"], " ".join(args), len(got), "yes" if ok_golden else "NO", "yes" if rg_lines is not None and ok_live else ("n/a" if rg_lines is None else "NO"), c.get("note", "")))
        if not ok:
            print(f"MISMATCH {c['id']} {args}\n  sect: {got[:5]}\n  rg:   {(rg_lines or golden or [])[:5]}")

    def st(xs: list[float]) -> str:
        xs = sorted(xs)
        return f"{statistics.median(xs):.1f} | {xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))]:.1f}" if xs else "n/a | n/a"

    L = ["# Milestone 3 results: `sect grep` parity with ripgrep on the fixture corpus\n",
         f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}; release `sect`; ripgrep: {rg_version}. "
         "Both tools run over `fixtures/corpus` (44 markdown files and 4 `_source.yaml`); rg is invoked with `--sort path -n --color never` plus the case flags, "
         "and its Windows path separators are normalised. `sect grep` output is compared after its two header lines (and any `note:` line).\n",
         "Command: `uv run --project proto python eval/eval_m3.py` (`--update-golden` re-records rg output into `eval/golden/grep/`)\n",
         f"**Result: {'PASS' if all_ok else 'FAIL'}: {sum(1 for r in rows if r[3] == 'yes' and r[4] in ('yes', 'n/a'))} of {len(rows)} cases identical.**\n",
         "| Case | Flags and pattern | Lines | Matches golden | Matches live rg | Note |", "|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r[0]} | `{r[1]}` | {r[2]} | {r[3]} | {r[4]} | {r[5]} |")
    L.append("\n## Latency (ms per invocation, including process start-up)\n")
    L.append("| Tool | n | p50 | p95 |")
    L.append("|---|---|---|---|")
    L.append(f"| `sect grep` (opens the index first: freshness stat of 44 files) | {len(t_sect)} | {st(t_sect)} |")
    L.append(f"| `rg` | {len(t_rg)} | {st(t_rg)} |")
    L.append("\n`sect grep` scans every file (the milestone-3b n-gram prefilter is gated on a measured speedup over a 3-title corpus); on 48 small files the cost is process start-up and the index freshness check.\n")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L[:6]))
    print(f"... {len(rows)} cases; wrote {OUT}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
