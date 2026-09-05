"""Build an isolated scale corpus with explicit environment and directly streamed native logs."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from types import SimpleNamespace
from qualification import Mcp

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--corpus", type=Path, required=True)
parser.add_argument("--logs", type=Path, required=True)
args = parser.parse_args()
args.logs.parent.mkdir(parents=True, exist_ok=True)
paths = {k: Path(str(args.logs) + suffix) for k, suffix in [("stdout", ".json"), ("stderr", ".stderr"), ("run", ".run.json")]}
if any(p.exists() for p in paths.values()):
    raise ValueError("preserve previous logs; choose a new log prefix")
environment = {**os.environ, "SECT_TIMING": "1"}
command = [str(args.binary.resolve()), "index", str(args.corpus.resolve()), "--passage-target", "512", "--passage-max", "800", "--json"]
started = dt.datetime.now(dt.timezone.utc).isoformat()
binary_sha = hashlib.sha256(args.binary.read_bytes()).hexdigest()
start = time.perf_counter()
peak = None
with paths["stdout"].open("xb") as stdout, paths["stderr"].open("xb") as stderr:
    child = subprocess.Popen(command, stdout=stdout, stderr=stderr, env=environment)
    print(json.dumps({"pid": child.pid, "command": command, "timing_enabled": environment["SECT_TIMING"], "logs": str(args.logs)}), flush=True)
    while child.poll() is None:
        rss = Mcp.peak_rss(SimpleNamespace(child=child))
        if rss is not None:
            peak = max(peak or 0, rss)
        time.sleep(.5)
report = {"started": started, "command": command, "returncode": child.returncode,
          "elapsed_ms": (time.perf_counter() - start) * 1000, "sampled_peak_rss_bytes": peak,
          "binary_sha256": binary_sha, "environment": {"SECT_TIMING": "1"}}
paths["run"].write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
print(json.dumps(report), flush=True)
raise SystemExit(child.returncode)
