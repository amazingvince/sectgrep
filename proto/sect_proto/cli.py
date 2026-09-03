"""`sect-proto`: milestone-0 prototype CLI (throwaway; mirrors the seven `sect` verbs loosely)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="sect-proto")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("validate", help="check a corpus against the spec B.2 contract")
    v.add_argument("corpus")

    s = sub.add_parser("search", help="hybrid search with the spec B.4 signals")
    s.add_argument("corpus")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--as-of")
    s.add_argument("--include-superseded", action="store_true")
    s.add_argument("--kind")
    s.add_argument("--source")
    s.add_argument("--expand", choices=["refs", "ancestors"])
    s.add_argument("--baseline", choices=["bm25", "vector", "semble"], help="run a baseline arm instead")
    s.add_argument("--json", action="store_true")

    for name in ("read", "map", "refs", "history"):
        c = sub.add_parser(name)
        c.add_argument("corpus")
        c.add_argument("id")
        if name == "read":
            c.add_argument("--as-of")
        if name == "map":
            c.add_argument("--anchor")
        if name == "refs":
            c.add_argument("--direction", default="out", choices=["in", "out", "both"])
            c.add_argument("--type")
            c.add_argument("--depth", type=int, default=1)

    d = sub.add_parser("define")
    d.add_argument("corpus")
    d.add_argument("term")

    cc = sub.add_parser("crossref-candidates", help="CRAwLeR step 1: (target, referenced) pairs for the author to write queries for")
    cc.add_argument("corpus")
    cc.add_argument("--out", required=True)

    f = sub.add_parser("filter", help="CRAwLeR adversarial filter over crossref.jsonl")
    f.add_argument("corpus")
    f.add_argument("--questions", required=True)
    f.add_argument("--rank", type=int, default=10)

    e = sub.add_parser("eval", help="run the E.1 question set and write the milestone-0 report")
    e.add_argument("--corpus", required=True)
    e.add_argument("--questions", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--gate", type=float, default=0.85)
    e.add_argument("--filter-rank", type=int, default=10)
    e.add_argument("--refilter", action="store_true")
    e.add_argument("--floor-lex", type=float, default=0.34)
    e.add_argument("--floor-sem", type=float, default=0.30)
    e.add_argument("--floor-hard", type=float, default=0.22)

    ab = sub.add_parser("ablation", help="chunk-text / stemming / mean-centering ablation for the report")
    ab.add_argument("--corpus", required=True)
    ab.add_argument("--questions", required=True)
    ab.add_argument("--out", required=True)

    a = p.parse_args(argv)
    from .corpus import Corpus

    if a.cmd == "ablation":
        from .ablation import run as run_ablation

        run_ablation(Corpus(a.corpus), Path(a.questions), Path(a.out))
        return 0

    if a.cmd == "validate":
        from .validate import validate

        corpus = Corpus(a.corpus)
        errors, warnings = validate(corpus)
        for w in warnings:
            print(f"warning: {w}")
        for e_ in errors:
            print(f"error: {e_}")
        st = corpus.stats()
        print(f"validated {st['expressions']} files in {st['sources']} sources: {len(errors)} errors, {len(warnings)} warnings")
        return 1 if errors else 0

    if a.cmd == "eval":
        from .evaluate import run

        ok = run(Corpus(a.corpus), Path(a.questions), Path(a.out), a.gate, a.filter_rank, a.floor_lex, a.floor_sem, a.refilter, a.floor_hard)
        print(f"gate {'PASSED' if ok else 'FAILED'}")
        return 0 if ok else 1

    corpus = Corpus(a.corpus)
    if a.cmd == "crossref-candidates":
        from .questions import crossref_candidates, write_jsonl

        rows = crossref_candidates(corpus)
        write_jsonl(Path(a.out), rows)
        print(f"{len(rows)} candidate targets written to {a.out}")
        return 0

    if a.cmd == "filter":
        from .index import Searcher
        from .questions import adversarial_filter, read_jsonl, write_jsonl

        qdir = Path(a.questions)
        rows = adversarial_filter(Searcher(corpus, contextual=False), read_jsonl(qdir / "crossref.jsonl"), a.rank)
        write_jsonl(qdir / "crossref.filtered.jsonl", rows)
        kept = sum(1 for r in rows if r["filter"]["kept"])
        for r in rows:
            fl = r["filter"]
            print(f"{r['qid']}: bm25={fl['baseline_bm25_rank']} vector={fl['baseline_vector_rank']} kept={fl['kept']}")
        print(f"kept {kept} of {len(rows)} at rank threshold {a.rank}")
        return 0

    if a.cmd == "search":
        from .index import Searcher

        S = Searcher(corpus, contextual=True)
        if a.baseline:
            for i, wid in enumerate(S.baseline(a.query, a.baseline, a.limit), 1):
                print(f"{i}. {wid}  {corpus.current[wid].title}")
            return 0
        as_of = dt.date.fromisoformat(a.as_of) if a.as_of else None
        res = S.search(a.query, a.limit, as_of, a.include_superseded, a.kind, a.source, a.expand)
        if a.json:
            print(json.dumps({"query": res.query, "abstained": res.abstained, "nearest": res.nearest, "latency_ms": res.latency_ms,
                              "hits": [{"id": h.section.id, "expr": h.section.expr, "title": h.section.title, "score": h.score, "anchor": h.anchor,
                                        "reason": h.reason, "overridden_by": corpus.overridden_by.get(h.section.id, []),
                                        "narrowed_by": corpus.narrowed_by.get(h.section.id, []), "expanded": h.expanded} for h in res.hits]}, indent=2))
            return 0
        for line in res.lines:
            print(line)
        if res.abstained:
            print(f"not found; nearest scope: {res.nearest}")
        for i, h in enumerate(res.hits, 1):
            flags = []
            if corpus.overridden_by.get(h.section.id):
                flags.append("overridden-by " + ",".join(corpus.overridden_by[h.section.id]))
            if corpus.narrowed_by.get(h.section.id):
                flags.append("narrowed-by " + ",".join(f"{n['id']}#{n['anchor']}" for n in corpus.narrowed_by[h.section.id]))
            anchor = f"#{h.anchor}" if h.anchor else ""
            print(f"{i}. {h.section.id}{anchor}  {h.section.breadcrumb}  eff {h.section.effective}  score {h.score}"
                  + (f"  [{h.reason}]" if h.reason else "") + (f"  {'; '.join(flags)}" if flags else ""))
            for e in h.expanded:
                print(f"     -> {e['id']}{'#' + e['anchor'] if e.get('anchor') else ''} {e['title']}")
        print(f"latency {res.latency_ms:.1f} ms; lexical overlap {res.lex_conf:.2f}; cosine {res.sem_conf:.2f}")
        return 0

    if a.cmd == "read":
        sec = corpus.as_of(a.id.split("@")[0], dt.date.fromisoformat(a.as_of)) if a.as_of else corpus.section(a.id)
        if not sec:
            print(f"not found as of {a.as_of}" if a.as_of else "not found")
            return 1
        print(f"{sec.expr}  {sec.breadcrumb}")
        st = corpus.overlay_status(sec.id)
        if st["overridden_by"]:
            print(f"overridden-by: {', '.join(st['overridden_by'])}")
        for n in st["narrowed_by"]:
            print(f"narrowed-by: {n['id']} at #{n['anchor']}")
        print(sec.body)
        return 0
    if a.cmd == "map":
        print(json.dumps(corpus.map_complete(a.id, a.anchor)))
        return 0
    if a.cmd == "refs":
        for e_ in corpus.refs(a.id, a.direction, a.type, a.depth):
            print(json.dumps(e_))
        return 0
    if a.cmd == "history":
        print(json.dumps(corpus.history(a.id)))
        return 0
    if a.cmd == "define":
        print(json.dumps(corpus.define(a.term)))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
