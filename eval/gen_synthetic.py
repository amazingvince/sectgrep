"""Generate a synthetic corpus in the spec B.2 contract for scale tests (spec B.6 targets: full build
of ~5-10k sections, freshness stat of 10k files).

  uv run --project proto python eval/gen_synthetic.py --sections 10000 --out corpora/synthetic

Layout: one base source `syn-title-7` with parts of 100 sections each; short bodies with a link to a
neighbouring section, a defined term in every tenth section, and a deterministic 45-word context.
Nothing in it is real law.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

SOURCE = """name: syn-title-7
kind: base
title: "Title 7 - Synthetic Scale Corpus (not real law)"
publisher: "sectgrep eval (synthetic)"
precedence: 100
id_prefix: "SYN:7-"
id_pattern: '(?i)(?:\\b7\\s*C\\.?F\\.?R\\.?\\s*(?:§\\s*)?|§\\s*|\\bsection\\s+)(?P<part>\\d{1,4})\\.(?P<section>\\d{1,4})'
id_template: "SYN:7-{part}.{section}"
anchor_template: ""
legal_status: derived
version: "2026-01-01"
acquire: "generated"
"""

WORDS = "employer employee workplace hazard guardrail ladder exit route record report inspection penalty notice variance training surface load platform opening".split()


def front(id_, node, title, level, parent, order, defines, context):
    return "\n".join([
        "---", f'id: "{id_}"', f'node: "{node}"', 'source: "syn-title-7"', f'title: "{title}"', f'level: "{level}"',
        f'parent: {"null" if parent is None else chr(34) + parent + chr(34)}', f"order: {order}", "effective: 2026-01-01",
        "supersedes: null", "superseded_by: null", "amended_by: []", "overrides: []", "narrows: []",
        f"defines: {defines}", 'authority: "7 U.S.C. 1"', 'citation: "91 FR 1, Jan. 1, 2026"', "tags: []",
        f'context: "{context}"', "provenance:", '  raw: "raw/syn-title-7/2026-01-01/synthetic.xml"',
        f'  raw_sha256: "{hashlib.sha256(id_.encode()).hexdigest()}"', f"  locator: {{xpath: \"//DIV8[@NODE='{node}']\"}}",
        "  legal_status: derived", '  ingest_run: "2026-09-03T00:00Z/synthetic"', "  confidence: 1.0", "  verified_by: [generator]", "---", ""])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sections", type=int, default=10000)
    ap.add_argument("--out", default="corpora/synthetic")
    a = ap.parse_args()
    root = Path(a.out) / "syn-title-7"
    root.mkdir(parents=True, exist_ok=True)
    (root / "_source.yaml").write_text(SOURCE, encoding="utf-8", newline="\n")
    per_part = 100
    parts = (a.sections + per_part - 1) // per_part
    ctx_pad = "It sits in the synthetic scale corpus used to measure index build time and the freshness stat pass at ten thousand files; the text is generated, repetitive by design, and refers to a neighbouring section so the cross-reference graph is not empty."
    (root / "7.md").write_text(front("SYN:7", "7", "Synthetic Scale Corpus", "title", None, 7, "[]", f"Root of the synthetic title with {parts} parts. " + ctx_pad) + "\n# Title 7 - Synthetic Scale Corpus\n\n" + "\n".join(f"- [Part {p}](SYN:7-{p})" for p in range(1, parts + 1)) + "\n", encoding="utf-8", newline="\n")
    n = 0
    for p in range(1, parts + 1):
        pdir = root / str(p)
        pdir.mkdir(exist_ok=True)
        count = min(per_part, a.sections - n)
        (pdir / f"7-{p}.md").write_text(front(f"SYN:7-{p}", f"7:{p}", f"Part {p} provisions", "part", "SYN:7", p, "[]", f"Part {p} of the synthetic title with {count} sections. " + ctx_pad) + f"\n# Part {p} - Part {p} provisions\n\n" + "\n".join(f"- [§ {p}.{s} Section {p}.{s}](SYN:7-{p}.{s})" for s in range(1, count + 1)) + "\n", encoding="utf-8", newline="\n")
        for s in range(1, count + 1):
            n += 1
            w = [WORDS[(n + i) % len(WORDS)] for i in range(6)]
            neighbour = f"SYN:7-{p}.{s + 1 if s < count else 1}"
            term = f"term{n}" if n % 10 == 0 else None
            defines = f'["{term}"]' if term else "[]"
            body = [f"# § {p}.{s} Section {p}.{s}", "", f"(a) Each {w[0]} shall ensure that every {w[1]} at the {w[2]} is protected from the {w[3]} hazard described in [§ {p}.{s + 1 if s < count else 1}]({neighbour}).", "", f"(b) The {w[4]} shall be inspected before each shift and the {w[5]} recorded on the log."]
            if term:
                body += ["", f"*{term}* means the synthetic term number {n} used to exercise the definitions index."]
            ctx = f"§ {p}.{s} Section {p}.{s}, within Part {p} (Part {p} provisions) of Title 7. It refers to § {p}.{s + 1 if s < count else 1} (Section {p}.{s + 1 if s < count else 1}). " + ctx_pad
            sdir = pdir / f"{p}.{s}"
            sdir.mkdir(exist_ok=True)
            (sdir / f"7-{p}.{s}.md").write_text(front(f"SYN:7-{p}.{s}", f"7:{p}.{s}", f"Section {p}.{s}", "section", f"SYN:7-{p}", s, defines, ctx) + "\n" + "\n".join(body) + "\n", encoding="utf-8", newline="\n")
    print(f"generated {n} sections in {parts} parts under {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
