"""bakeoff: prepare | serve <model> | stop | run <arm> [--docs ...] [--long-side N] | consensus | score | report

Run from WSL2 with the uv environments under ~/venvs. `run api-<model>` and `run sdk-<model>`
need `serve <model>` first (one model on the GPU at a time).
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
from pathlib import Path

from . import arms
from .manifest import RAW, ROOT, build

PIDFILE = Path.home() / "bakeoff" / "vllm.pid"


def load_manifest() -> dict:
    return json.loads((RAW / "manifest.json").read_text(encoding="utf-8"))


def cmd_prepare(_a) -> int:
    m = build()
    for d in m["docs"]:
        arms.doc_pdf(d)
    print(f"{len(m['docs'])} documents, {m['pages_total']} pages; golden under eval/golden/bakeoff/")
    return 0


def cmd_serve(a) -> int:
    if PIDFILE.exists():
        cmd_stop(a)
    p = arms.start_server(a.model)
    PIDFILE.write_text(str(p.pid))
    print(f"vllm serving {arms.MODELS[a.model]['repo']} (pid {p.pid}) at {arms.SERVER}")
    return 0


def cmd_stop(_a) -> int:
    if PIDFILE.exists():
        pid = int(PIDFILE.read_text())
        try:
            subprocess.run(["pkill", "-TERM", "-P", str(pid)])
            import os
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        PIDFILE.unlink()
        subprocess.run(["pkill", "-f", "vllm serve"])
    return 0


def cmd_run(a) -> int:
    docs = load_manifest()["docs"]
    if a.docs:
        docs = [d for d in docs if d["doc"] in a.docs]
    if a.group:
        docs = [d for d in docs if d["group"] == a.group]
    arm = a.arm
    tag = a.tag
    for d in docs:
        if arms.done(tag or arm, d["doc"]) and not a.force:
            continue
        print(f"[{tag or arm}] {d['doc']}", flush=True)
        if arm == "docling":
            arms.run_docling(d)
        elif arm == "marker":
            arms.run_marker(d)
        elif arm.startswith("api-"):
            arms.run_api(arm[4:], d, long_side=a.long_side, tag=tag)
        elif arm == "sdk-paddle":
            arms.run_sdk_paddle(d)
        elif arm == "sdk-glmocr":
            arms.run_sdk_glmocr(d)
        elif arm == "sdk-olmocr":
            arms.run_sdk_olmocr(docs)
            break
        else:
            raise SystemExit(f"unknown arm {arm}")
    return 0


def cmd_consensus(_a) -> int:
    from .consensus import build_scan_golden
    n = build_scan_golden(load_manifest()["docs"])
    print(f"wrote consensus golden for {n} scanned pages (marked for hand check)")
    return 0


def cmd_score(a) -> int:
    from .scoring import score_all
    rows = score_all(load_manifest()["docs"], a.arms)
    (RAW / "scores.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    print(f"scored {len(rows)} (arm, doc) pairs -> raw/bakeoff/scores.json")
    return 0


def cmd_report(_a) -> int:
    from .report import write_report
    out = write_report(load_manifest(), json.loads((RAW / "scores.json").read_text(encoding="utf-8")))
    print(f"wrote {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="bakeoff")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("prepare").set_defaults(fn=cmd_prepare)
    s = sub.add_parser("serve")
    s.add_argument("model", choices=list(arms.MODELS))
    s.set_defaults(fn=cmd_serve)
    sub.add_parser("stop").set_defaults(fn=cmd_stop)
    r = sub.add_parser("run")
    r.add_argument("arm")
    r.add_argument("--docs", nargs="*")
    r.add_argument("--group", choices=["born", "table", "scan"])
    r.add_argument("--long-side", type=int)
    r.add_argument("--tag")
    r.add_argument("--force", action="store_true")
    r.set_defaults(fn=cmd_run)
    sub.add_parser("consensus").set_defaults(fn=cmd_consensus)
    sc = sub.add_parser("score")
    sc.add_argument("--arms", nargs="*")
    sc.set_defaults(fn=cmd_score)
    sub.add_parser("report").set_defaults(fn=cmd_report)
    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
