#!/usr/bin/env python3
"""Milestone H2 evidence (GOAL.md G-N): the verifier measured against the fixture's golden labels,
consensus over the Title 4 ingest run, the first auto-merge into corpus/ through the merge script,
and the acceptance sample. Writes eval/results/h2.md.

    python eval/eval_h2.py [--run staging/<run_id>] [--source cfr-title-4] [--no-merge]

Needs the harness built, a release sect binary, and the verifier model from .env.
"""
from __future__ import annotations

import argparse
import glob
import json
import platform
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "packages" / "sect-harness" / "dist" / "cli.js"
SECT = next((p for p in [ROOT / "target" / "release" / "sect.exe", ROOT / "target" / "release" / "sect"] if p.exists()), Path("sect"))
OUT = ROOT / "eval" / "results" / "h2.md"
FIXTURE = ROOT / "fixtures" / "corpus"
LINK = re.compile(r"\[([^\]]*)\]\((CFR:[^)\s#]+)(?:#([a-z0-9-]+))?\)")


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        sys.exit(f"{' '.join(str(c) for c in cmd)}\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
    return r


def front_and_body(text: str) -> tuple[str, str]:
    end = text.index("\n---", 3)
    return text[4:end], text[text.index("\n", end + 1) + 1 :]


def golden_inputs(work: Path) -> tuple[Path, dict]:
    """The fixture as WS2 would deliver it: links flattened to bare citations; overlays and the
    notice with their judgment fields blanked. The originals are the golden labels."""
    src = FIXTURE / "cfr-title-99"
    out = work / "verify-goldens" / "cfr-title-99"
    if out.exists():
        shutil.rmtree(out.parent)
    goldens: dict[str, dict] = {}
    for f in list(src.rglob("*.md")):
        rel = f.relative_to(src)
        text = f.read_text(encoding="utf-8")
        front, body = front_and_body(text)
        sid = re.search(r"^id:\s*\"?([^\"\n]+?)\"?\s*$", front, re.M).group(1)
        xrefs = [(m.group(1), m.group(2), m.group(3)) for m in LINK.finditer(body)]
        defines = re.search(r"^defines:\s*\[([^\]]*)\]", front, re.M)
        goldens[sid] = {"xrefs": {t: f"{i}{'#' + a if a else ''}" for t, i, a in xrefs}, "defines": [d.strip() for d in defines.group(1).split(",") if d.strip()] if defines else []}
        bare = LINK.sub(r"\1", body)
        front2 = re.sub(r"^defines:.*$", "defines: []", front, flags=re.M)
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(f"---\n{front2}\n---\n{bare}", encoding="utf-8", newline="\n")
    shutil.copy(src / "_source.yaml", out / "_source.yaml")
    return out, goldens


def measure_goldens(work: Path) -> dict:
    inp, goldens = golden_inputs(work)
    staging = work / "verify-goldens-staging"
    if staging.exists():
        shutil.rmtree(staging)
    # A dry-run ingest stages the bare inputs (no model); the verifier then judges them blind.
    r = run(["node", str(HARNESS), "ingest", "--input", str(inp), "--source", "cfr-title-99", "--corpus", str(FIXTURE), "--staging", str(staging), "--raw-root", str(ROOT / "fixtures"), "--work", str(ROOT / "fixtures" / "work"), "--dry-run", "--json"], check=False)
    res = json.loads(r.stdout[r.stdout.find("{"):])
    run_dir = Path(res["runDir"])
    t0 = time.perf_counter()
    v = run(["node", str(HARNESS), "verify", "--run", str(run_dir), "--input", str(inp), "--source", "cfr-title-99", "--corpus", str(FIXTURE), "--staging", str(staging), "--review", str(work / "verify-goldens-review"), "--concurrency", "6", "--json"], check=False)
    secs = time.perf_counter() - t0
    report = json.load(open(run_dir / "verify.json", encoding="utf-8"))
    tp = fp = fn = 0
    d_tp = d_fp = d_fn = 0
    judged = 0
    for s in report["sections"]:
        g = goldens.get(s["id"], {"xrefs": {}, "defines": []})
        seen = set()
        for j in s["judgments"]:
            if j["field"] == "xref":
                judged += 1
                seen.add(j["text"])
                want = g["xrefs"].get(j["text"])
                got = j["verifier"] if j["verifier"] not in ("(none)", "(not judged)") else None
                if got and want and got.split("#")[0] == want.split("#")[0]:
                    tp += 1
                elif got:
                    fp += 1
                elif want:
                    fn += 1
            elif j["field"] == "defines":
                gv = {d.lower() for d in g["defines"]}
                vv = {d.strip().lower() for d in j["verifier"].split(",") if d.strip() and d.strip() != "(none)"}
                d_tp += len(gv & vv)
                d_fp += len(vv - gv)
                d_fn += len(gv - vv)
        for t, want in g["xrefs"].items():
            if t not in seen:
                fn += 1
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    dprec = d_tp / (d_tp + d_fp) if d_tp + d_fp else 0.0
    drec = d_tp / (d_tp + d_fn) if d_tp + d_fn else 0.0
    return {"sections": report["counts"]["sections"], "judged": judged, "tp": tp, "fp": fp, "fn": fn, "precision": prec, "recall": rec, "d_tp": d_tp, "d_fp": d_fp, "d_fn": d_fn, "d_precision": dprec, "d_recall": drec, "usage": report["usage"], "verifier": report["verifier"], "seconds": secs}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=sorted(glob.glob(str(ROOT / "staging" / "cfr-title-4-*")))[-1] if glob.glob(str(ROOT / "staging" / "cfr-title-4-*")) else "")
    ap.add_argument("--source", default="cfr-title-4")
    ap.add_argument("--input", default=str(ROOT / "work" / "ingest-input" / "cfr-title-4"))
    ap.add_argument("--corpus", default="corpora/ecfr")
    ap.add_argument("--merge-corpus", default="corpus")
    ap.add_argument("--no-merge", action="store_true")
    a = ap.parse_args()
    work = ROOT / "work"
    gold = measure_goldens(work)
    # Consensus over the real run.
    t0 = time.perf_counter()
    v = run(["node", str(HARNESS), "verify", "--run", a.run, "--input", a.input, "--source", a.source, "--corpus", a.corpus, "--concurrency", "8", "--json"], check=False)
    vsecs = time.perf_counter() - t0
    if v.returncode != 0:
        sys.exit(v.stdout[-2000:] + v.stderr[-2000:])
    report = json.load(open(Path(a.run) / "verify.json", encoding="utf-8"))
    counts = report["counts"]
    fields = Counter(j["field"] for s in report["sections"] for j in s["judgments"] if not j.get("deterministic"))
    disagree = Counter(j["field"] for s in report["sections"] for j in s["judgments"] if not j["agree"])
    merge_line = ""
    sample_line = ""
    if not a.no_merge:
        m = run(["node", str(HARNESS), "merge", "--run", a.run, "--source", a.source, "--corpus", a.merge_corpus, "--sect", str(SECT), "--commit"], check=False)
        merge_line = (m.stdout + m.stderr).strip().splitlines()[-1] if (m.stdout + m.stderr).strip() else "merge produced no output"
        s = run(["node", str(HARNESS), "sample", "--run", a.run, "--source", a.source], check=False)
        sample_line = (s.stdout + s.stderr).strip().splitlines()[-1] if (s.stdout + s.stderr).strip() else ""
    md = ["# Milestone H2: verification, consensus, sampling, merge\n"]
    md.append(f"Generated by `python eval/eval_h2.py` on {platform.system()} {platform.release()}; verifier {report['verifier']['provider']} `{report['verifier']['model']}` (docs/decisions.md #43), ingest model per #41.\n")
    md.append("## Verifier against golden labels (the fixture corpus, blind)\n")
    md.append(f"The fixture's {gold['sections']} Title 99 files were handed to the verifier as WS2 would deliver them, links flattened to bare citations and definitions blanked; the originals are the labels. {gold['judged']} references judged in {gold['seconds']:.0f} s, {gold['usage']['calls']} calls, ${gold['usage']['cost']:.4f}.\n")
    md.append("| Field | True positive | False positive | False negative | Precision | Recall |")
    md.append("|---|---|---|---|---|---|")
    md.append(f"| references (id) | {gold['tp']} | {gold['fp']} | {gold['fn']} | {gold['precision']:.3f} | {gold['recall']:.3f} |")
    md.append(f"| defined terms | {gold['d_tp']} | {gold['d_fp']} | {gold['d_fn']} | {gold['d_precision']:.3f} | {gold['d_recall']:.3f} |")
    md.append("")
    md.append(f"## Consensus over the Title 4 run ({report['run_id']})\n")
    md.append(f"`sect-harness verify`: {counts['sections']} sections, {counts['auto']} auto, {counts['conflict']} conflict; agreement on {counts['agreements']} of {counts['judgments']} judgment fields (**{100 * report['agreement_rate']:.1f}%**), {counts['deterministic']} explicit citations not counted as judgments; {counts['evidence_fails']} evidence failures; verifier cost ${report['usage']['cost']:.4f} over {report['usage']['calls']} calls, {vsecs:.0f} s at inspection level {report['level']}.\n")
    md.append("| Field | Judged | Disagreements |")
    md.append("|---|---|---|")
    for f in sorted(fields):
        md.append(f"| {f} | {fields[f]} | {disagree.get(f, 0)} |")
    md.append("")
    md.append(f"Conflicts are in `review/{report['run_id']}.md` with both proposals, the ingest agent's searches, and the verifier's reasons; they stay there until a person resolves them.\n")
    md.append("## Merge and sample\n")
    md.append(f"- {merge_line or 'merge skipped'}")
    md.append(f"- {sample_line or 'sample skipped'}")
    md.append("- Rollback: `sect-harness rollback --commit <sha> --corpus corpus` runs `git revert --no-edit` and refreshes the index.")
    md.append("")
    md.append("## Sampling plan\n")
    md.append("ANSI/ASQ Z1.4 attribute sampling by procedure: the lot is the run's merged items, the acceptance number is zero, and the switching rules are the standard's (tightened after two of five consecutive lots rejected, normal after five accepted in a row, reduced after ten accepted in a row with the error rate under 2 percent, normal on any rejection). Sample sizes are the spec's default of 20 at normal inspection with the standard's neighbouring sizes 32 (tightened) and 8 (reduced). At tightened inspection an agreeing reference below confidence 0.8 is a conflict. State per source in `review/sampling/<source>.json`.\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(md) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}: goldens P {gold['precision']:.3f} R {gold['recall']:.3f}; run agreement {100 * report['agreement_rate']:.1f}% ({counts['auto']} auto / {counts['conflict']} conflict); {merge_line}")


if __name__ == "__main__":
    main()
