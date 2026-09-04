#!/usr/bin/env python3
"""Milestone H3 evidence (GOAL.md G-O): overlays and notices end to end, generic, with the CFR and
Federal Register sources as the example. Phases, each idempotent (runs reuse the ledger, merges
skip unchanged files):

  title4   re-merge Title 4 into corpus/ with per-section dates (the G-N2 run, verified)
  prior    part 28 of Title 4 as of 2024-06-17 (the pre-amendment text) into corpus/
  notice   Federal Register rule 2024-13064 ingested; the new Expressions composed; merged
  base1910 part 1910 of Title 29 into corpus/ (the base the overlay amends)
  overlay  Iowa 875 chapter 10 (a state plan's exceptions to part 1910) ingested and merged
  report   the measures against review/h3-labels.md and the versioner's diff; eval/results/h3.md

    python eval/eval_h3.py [--phases title4,prior,notice,base1910,overlay,report] [--no-commit]

Needs the converter and harness built, a release sect binary, and the models from .env.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONVERT = ROOT / "packages" / "sect-convert" / "dist" / "cli.js"
HARNESS = ROOT / "packages" / "sect-harness" / "dist" / "cli.js"
SECT = next((p for p in [ROOT / "target" / "release" / "sect.exe", ROOT / "target" / "release" / "sect"] if p.exists()), Path("sect"))
OUT = ROOT / "eval" / "results" / "h3.md"
LABELS = ROOT / "review" / "h3-labels.md"
CORPUS = "corpus"

# The agent's reading of the rule's fifteen amendatory instructions: the target Work, the
# paragraph, and the kind of change. Marked agent-drafted in the sheet until a person confirms.
EXPECTED = {
    "instr-1": ("CFR:4-28", None, "amend", "authority citation of the part; not a text amendment"),
    "instr-2": ("CFR:4-28", None, "remove", "pronoun table applied wherever the phrases appear in the part"),
    "instr-3": ("CFR:4-28.80", None, "remove", "“he or she determines” becomes “they determine”"),
    "instr-4": ("CFR:4-28.95", None, "amend", "header for a, b, c below"),
    "instr-5": ("CFR:4-28.95", "c", "amend", "paragraph (c) revised"),
    "instr-6": ("CFR:4-28.95", "d", "remove", "the word “or” removed at the end of (d)"),
    "instr-7": ("CFR:4-28.95", "e", "redesignate", "(e) becomes (g); new (e), (f), (h)"),
    "instr-8": ("CFR:4-28.98", None, "amend", "header for a to f below"),
    "instr-9": ("CFR:4-28.98", "a", "amend", "(a), (b) introductory text, (b)(1), (b)(2) revised"),
    "instr-10": ("CFR:4-28.98", "c", "amend", "the (c) heading revised"),
    "instr-11": ("CFR:4-28.98", "c-1", "amend", "“Office of” inserted in (c)(1)"),
    "instr-12": ("CFR:4-28.98", "c-2", "amend", "sentences of (c)(2) and all of (d) revised"),
    "instr-13": ("CFR:4-28.98", "e", "redesignate", "(e) becomes (f); new (e)"),
    "instr-14": ("CFR:4-28.98", "f", "add", "heading for (f); new (f)(3)"),
    "instr-15": ("CFR:4-28.112", "a-2", "remove", "“his, her or” removed in (a)(2)"),
}


def run(cmd: list[str], check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    e = dict(os.environ)
    e["MSYS_NO_PATHCONV"] = "1"
    if env:
        e.update(env)
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", env=e)
    if check and r.returncode != 0:
        sys.exit(f"{' '.join(str(c) for c in cmd)}\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
    return r


def latest_run(staging: str, source: str) -> Path | None:
    runs = sorted(glob.glob(str(ROOT / staging / f"{source}-*")), key=os.path.getmtime)
    return Path(runs[-1]) if runs else None


def harness_json(args: list[str]) -> dict:
    r = run(["node", str(HARNESS), *args, "--json"], check=False)
    start = r.stdout.find("{")
    if start < 0:
        sys.exit(f"no result from the harness:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
    return json.loads(r.stdout[start:])


def verify(run_dir: Path, inp: str, source: str, corpus: str, concurrency: int = 6) -> dict:
    vf = run_dir / "verify.json"
    if not vf.exists():
        run(["node", str(HARNESS), "verify", "--run", str(run_dir), "--input", inp, "--source", source, "--corpus", corpus, "--sect", str(SECT), "--concurrency", str(concurrency)])
    return json.load(open(vf, encoding="utf-8"))


def merge(run_dir: Path, source: str, commit: bool) -> str:
    r = run(["node", str(HARNESS), "merge", "--run", str(run_dir), "--source", source, "--corpus", CORPUS, "--sect", str(SECT), *(["--commit"] if commit else [])], check=False)
    line = (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "merge produced no output"
    return line


def sect(args: list[str]) -> str:
    r = run([str(SECT), *args, "--corpus", CORPUS], check=False)
    return (r.stdout or r.stderr).strip()


def front_of(text: str) -> dict:
    import yaml  # type: ignore

    return yaml.safe_load(text.split("\n---\n", 1)[0].lstrip("-\n")) or {}


def body_of(text: str) -> str:
    return text.split("\n---\n", 1)[1] if "\n---\n" in text else text


def toks(s: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*", s.lower())


def containment(a: list[str], b: list[str]) -> float:
    bag = Counter(b)
    hit = 0
    for t in a:
        if bag[t] > 0:
            hit += 1
            bag[t] -= 1
    return hit / max(len(a), 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="title4,prior,notice,base1910,overlay,report")
    ap.add_argument("--no-commit", action="store_true")
    a = ap.parse_args()
    phases = set(a.phases.split(","))
    commit = not a.no_commit
    lines: dict[str, str] = {}

    if "title4" in phases:
        rd = latest_run("staging-t4", "cfr-title-4") or latest_run("staging-gn2", "cfr-title-4")
        v = verify(rd, "work/ingest-input/cfr-title-4", "cfr-title-4", "corpora/ecfr")
        lines["title4"] = f"verify: {v['counts']['auto']} auto, {v['counts']['conflict']} conflict, agreement {100 * v['agreement_rate']:.1f}%, ${v['usage']['cost']:.3f}; merge: {merge(rd, 'cfr-title-4', commit)}"

    if "prior" in phases:
        rd = latest_run("staging-h3prior", "cfr-title-4")
        if not rd:
            harness_json(["ingest", "--input", "work/h3-prior/cfr-title-4", "--source", "cfr-title-4", "--corpus", "corpora/ecfr", "--staging", "staging-h3prior", "--sect", str(SECT), "--only", "I/B/28/", "--concurrency", "8"])
            rd = latest_run("staging-h3prior", "cfr-title-4")
        v = verify(rd, "work/h3-prior/cfr-title-4", "cfr-title-4", "corpora/ecfr")
        lines["prior"] = f"verify: {v['counts']['auto']} auto, {v['counts']['conflict']} conflict; merge: {merge(rd, 'cfr-title-4', commit)}"

    notice_run = None
    if "notice" in phases:
        res = harness_json(["ingest", "--input", "work/h3-notice/fr", "--source", "fr", "--corpus", CORPUS, "--staging", "staging-h3notice", "--sect", str(SECT), "--concurrency", "2"])
        notice_run = Path(res["runDir"])
        v = verify(notice_run, "work/h3-notice/fr", "fr", CORPUS)
        lines["notice"] = f"ingest: {res['staged']} staged, {res['errors']} validator errors, ${res['usage']['cost']:.3f}; verify: {v['counts']['auto']} auto, {v['counts']['conflict']} conflict; merge: {merge(notice_run, 'fr', commit)}"
        lines["history"] = sect(["read", "CFR:4-28.95", "--history", "--no-refresh"])
        lines["amends"] = sect(["refs", "FR:2024-13064", "--type", "amends", "--no-refresh"])

    if "base1910" in phases:
        rd = latest_run("staging-1910", "cfr-title-29")
        if not rd:
            harness_json(["ingest", "--input", "work/ingest-input/cfr-title-29", "--source", "cfr-title-29", "--corpus", "corpora/ecfr", "--staging", "staging-1910", "--sect", str(SECT), "--only", "XVII/1910/", "--concurrency", "12"])
            rd = latest_run("staging-1910", "cfr-title-29")
        u = json.load(open(rd / "usage.json", encoding="utf-8"))
        v = verify(rd, "work/ingest-input/cfr-title-29", "cfr-title-29", "corpora/ecfr", concurrency=8)
        lines["base1910"] = f"ingest: {u['calls']} calls, ${u['cost']:.3f} over {u['document_tokens']} document tokens (${1e6 * u['cost'] / max(u['document_tokens'], 1):.2f}/M), {u.get('deterministic', 0)} references linked in code; verify: {v['counts']['auto']} auto, {v['counts']['conflict']} conflict, agreement {100 * v['agreement_rate']:.1f}%; merge: {merge(rd, 'cfr-title-29', commit)}"

    overlay_run = None
    if "overlay" in phases:
        res = harness_json(["ingest", "--input", "work/h3-overlay/ia-osh-ch10", "--source", "ia-osh-ch10", "--corpus", CORPUS, "--staging", "staging-h3overlay", "--sect", str(SECT), "--concurrency", "4"])
        overlay_run = Path(res["runDir"])
        v = verify(overlay_run, "work/h3-overlay/ia-osh-ch10", "ia-osh-ch10", CORPUS)
        lines["overlay"] = f"ingest: {res['staged']} item(s), {res['errors']} validator errors, ${res['usage']['cost']:.3f}; verify: {v['counts']['auto']} auto, {v['counts']['conflict']} conflict; merge: {merge(overlay_run, 'ia-osh-ch10', commit)}"
        recs = [json.load(open(f, encoding="utf-8")) for f in glob.glob(str(overlay_run / ".ingest" / "IA_*.json"))]
        lines["overlay_items"] = "\n".join(f"- {r['id']}: overrides {', '.join(o['id'] for o in r.get('overrides') or []) or '(none)'}; narrows {', '.join(n['id'] + ('#' + n['anchor'] if n.get('anchor') else '') for n in r.get('narrows') or []) or '(none)'}" for r in sorted(recs, key=lambda r: r["id"]))
        targets = sorted({o["id"] for r in recs for o in r.get("overrides") or []} | {n["id"] for r in recs for n in r.get("narrows") or []})
        lines["overlay_read"] = "\n".join(f"$ sect read {t}\n" + "\n".join(l for l in sect(["read", t, "--no-refresh"]).splitlines() if re.search(r"overrid|narrow", l, re.I))[:1200] for t in targets[:3])

    if "report" in phases:
        notice_run = notice_run or latest_run("staging-h3notice2", "fr") or latest_run("staging-h3notice", "fr")
        # Mapping reference: the versioner's diff between the two dates.
        run(["node", str(CONVERT), "align", "cfr-title-4", "2024-06-17", "2024-07-18", "--out", "work/h3-changes.json"])
        changes = json.load(open(ROOT / "work" / "h3-changes.json", encoding="utf-8"))
        changed = {c["id"] for c in changes.get("changes", changes.get("items", [])) if c.get("status", c.get("kind")) == "changed"} if isinstance(changes, dict) else {c["id"] for c in changes if c.get("status") == "changed"}
        rec = json.load(open(notice_run / ".ingest" / "FR_2024-13064.json", encoding="utf-8"))
        confirmed = {x["action_id"].split("#")[1]: x for x in rec.get("actions") or []}
        v = json.load(open(notice_run / "verify.json", encoding="utf-8"))
        nsec = next(s for s in v["sections"] if s["id"] == "FR:2024-13064")
        judged = {j["text"].split("#")[1]: j for j in nsec["judgments"] if j["field"] == "action"}
        rows = []
        tp = 0
        for k, (tid, anchor, kind, note) in EXPECTED.items():
            c = confirmed.get(k)
            got = f"{c['target_id']}{'#' + c['target_anchor'] if c and c.get('target_anchor') else ''}" if c else "(missing)"
            want = f"{tid}{'#' + anchor if anchor else ''}"
            ok = got == want
            tp += ok
            j = judged.get(k)
            rows.append(f"| {k} | {want} | {kind} | {got} | {c['kind'] if c else ''} | {'yes' if ok else 'no'} | {j['verifier'] if j else ''} | {'agree' if j and j['agree'] else 'conflict' if j else ''} | {note} |")
        precision = tp / len(EXPECTED)
        derived = [json.load(open(f, encoding="utf-8")) for f in glob.glob(str(notice_run / ".ingest" / "*.json"))]
        derived = [d for d in derived if d.get("derived")]
        produced = {d["id"] for d in derived}
        mp = len(produced & changed) / max(len(produced), 1)
        mr = len(produced & changed) / max(len(changed), 1)
        # Text agreement: each composed Expression against the versioner's 2024-07-18 text.
        agree = []
        for d in derived:
            rel = d["path"].split("/", 1)[1]
            cur = ROOT / "work" / "ingest-input" / "cfr-title-4" / rel
            if not cur.exists():
                continue
            composed = body_of((notice_run / d["path"]).read_text(encoding="utf-8"))
            actual = body_of(cur.read_text(encoding="utf-8"))
            agree.append((d["id"], containment(toks(composed), toks(actual)), containment(toks(actual), toks(composed)), toks(composed) == toks(actual)))
        unapplied = [f for d in derived for f in d["flags"] if f.startswith("unapplied")]
        held = [f for f in rec.get("flags", []) if f.startswith("composition held")]
        LABELS.parent.mkdir(parents=True, exist_ok=True)
        LABELS.write_text("\n".join([
            "# H3 label sheet: Federal Register rule 2024-13064 (4 CFR part 28)",
            "",
            "**Status: agent-drafted, not yet confirmed by a person.** Edit the expected columns and change this line to `Status: confirmed by <name> on <date>` when done; `python eval/eval_h3.py --phases report` recomputes the measures.",
            "",
            "Amendment mapping reference: the eCFR versioner's section diff between 2024-06-17 and 2024-07-18 (`sect-convert align`), which is the ground truth for which sections the rule changed.",
            "",
            "| Action | Expected target | Expected kind | Confirmed by ingest | Kind | Match | Verifier | Consensus | Note |",
            "|---|---|---|---|---|---|---|---|---|",
            *rows,
            "",
        ]), encoding="utf-8", newline="\n")
        md = ["# Milestone H3: overlays and notices, generic\n"]
        md.append(f"Generated by `python eval/eval_h3.py` on {platform.system()} {platform.release()}; ingest and verifier models per docs/decisions.md #41 and #43; design in #46.\n")
        md.append("## Runs\n")
        for k in ("title4", "prior", "notice", "base1910", "overlay"):
            if k in lines:
                md.append(f"- **{k}**: {lines[k]}")
        md.append("")
        md.append("## Action extraction (notice 2024-13064)\n")
        md.append(f"Against [review/h3-labels.md](../../review/h3-labels.md) (agent-drafted): **{tp} of {len(EXPECTED)} Actions have the expected target and paragraph, precision {precision:.3f}**; the converter's candidates were confirmed by the ingest agent and judged blind by the verifier ({sum(1 for j in judged.values() if j['agree'])} of {len(judged)} agree).\n")
        md.append("## Amendment mapping\n")
        md.append(f"The run composed new Expressions for {len(produced)} Works; the versioner says the rule changed {len(changed)}: **precision {mp:.3f}, recall {mr:.3f}** ({len(produced & changed)} in both). Unapplied Actions: {len(unapplied)}{' (' + '; '.join(unapplied[:6]) + ')' if unapplied else ''}. Compositions held for a person: {len(held)}{' (' + '; '.join(h[:200] for h in held[:4]) + ')' if held else ''}.\n")
        if agree:
            md.append("| Work | Composed text in the versioner's text | Versioner's text in the composed | Identical |")
            md.append("|---|---|---|---|")
            for wid, c1, c2, same in sorted(agree):
                md.append(f"| {wid} | {c1:.3f} | {c2:.3f} | {'yes' if same else 'no'} |")
            md.append("")
        if "history" in lines:
            md.append("## History and traversal\n")
            md.append("```\n$ sect read CFR:4-28.95 --history\n" + lines["history"][:2500] + "\n```\n")
            md.append("```\n$ sect refs FR:2024-13064 --type amends\n" + lines["amends"][:2500] + "\n```\n")
        if "overlay_items" in lines:
            md.append("## Overlay (Iowa 875 chapter 10 over 29 CFR part 1910)\n")
            md.append(lines["overlay_items"] + "\n")
            md.append("```\n" + lines.get("overlay_read", "") + "\n```\n")
        OUT.write_text("\n".join(md) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {OUT.relative_to(ROOT)}: action precision {precision:.3f}, mapping precision {mp:.3f} recall {mr:.3f}")
    for k, v in lines.items():
        if k in ("title4", "prior", "notice", "base1910", "overlay"):
            print(f"{k}: {v}")


if __name__ == "__main__":
    main()
