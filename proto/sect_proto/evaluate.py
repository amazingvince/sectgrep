"""Milestone-0 evaluation over the E.1 question types; writes eval/results/m0.md."""

from __future__ import annotations

import datetime as dt
import math
import platform
import statistics
import time
from collections import defaultdict
from pathlib import Path

from .corpus import Corpus
from .index import MODEL, Searcher
from .questions import adversarial_filter, read_jsonl, write_jsonl

RETRIEVAL_TYPES = ["locate", "id-lookup", "definition", "cross-ref", "overlay", "table", "negative", "amendment-history"]
XREF_ALL = "cross-ref (all 18, before filter)"
TYPE_ORDER = ["locate", "id-lookup", "definition", "cross-ref", XREF_ALL, "subtree-completeness", "overlay", "as-of",
              "amendment-history", "table", "no-gold", "wrong-corpus", "negative"]


def recall_at_k(gold: list[str], ranked: list[str], k: int) -> float:
    if not gold:
        return 0.0
    top = set(ranked[:k])
    return sum(1 for g in gold if g in top) / len(gold)


def ndcg_at_k(gold: list[str], ranked: list[str], k: int) -> float:
    if not gold:
        return 0.0
    dcg = sum(1 / math.log2(i + 2) for i, r in enumerate(ranked[:k]) if r in gold)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(gold), k)))
    return dcg / idcg if idcg else 0.0


def mrr(gold: list[str], ranked: list[str]) -> float:
    for i, r in enumerate(ranked):
        if r in gold:
            return 1 / (i + 1)
    return 0.0


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:.2f}"


def load_questions(qdir: Path) -> list[dict]:
    rows: list[dict] = []
    files = sorted(qdir.glob("*.jsonl"))
    names = {f.name for f in files}
    for f in files:
        if f.name == "crossref.jsonl" and "crossref.filtered.jsonl" in names:
            continue
        if f.name.endswith(".candidates.jsonl"):
            continue
        rows.extend(read_jsonl(f))
    return rows


def run(corpus: Corpus, qdir: Path, out: Path, gate: float, filter_rank: int, floor_lex: float, floor_sem: float, refilter: bool, floor_hard: float = 0.22) -> bool:
    t_index = time.perf_counter()
    S = Searcher(corpus, contextual=True)
    B = Searcher(corpus, contextual=False)
    index_ms = (time.perf_counter() - t_index) * 1000

    xref_path = qdir / "crossref.jsonl"
    filt_path = qdir / "crossref.filtered.jsonl"
    filter_stats = None
    if xref_path.exists() and (refilter or not filt_path.exists()):
        filtered = adversarial_filter(B, read_jsonl(xref_path), filter_rank)
        write_jsonl(filt_path, filtered)
    if filt_path.exists():
        rows = read_jsonl(filt_path)
        kept = [r for r in rows if r["filter"]["kept"]]
        filter_stats = {"candidates": len(rows), "kept": len(kept), "rank": rows[0]["filter"]["rank_threshold"] if rows else filter_rank, "rows": rows}

    questions = load_questions(qdir)
    per_type: dict[str, list[dict]] = defaultdict(list)
    latency: dict[str, list[float]] = defaultdict(list)
    failures: list[dict] = []
    baseline_hits: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    conf_rows: list[tuple] = []

    for q in questions:
        typ = q["type"]
        kept = not (typ == "cross-ref" and q.get("filter") and not q["filter"]["kept"])
        keys = ([typ] if kept else []) + ([XREF_ALL] if typ == "cross-ref" else [])
        rec = {"qid": q["qid"], "type": typ, "query": q.get("query", "")}
        gold = q.get("gold") or []
        exp = q.get("expected") or {}
        as_of = dt.date.fromisoformat(q["as_of"]) if q.get("as_of") else None
        if typ in RETRIEVAL_TYPES or typ in ("no-gold", "wrong-corpus"):
            t0 = time.perf_counter()
            res = S.search(q["query"], limit=10, as_of=as_of, expand="refs" if typ == "cross-ref" else None, floor_lex=floor_lex, floor_sem=floor_sem, floor_hard=floor_hard)
            latency["search"].append((time.perf_counter() - t0) * 1000)
            ranked = [h.section.id for h in res.hits]
            rec["top"] = ranked[:5]
            rec["abstained"] = res.abstained
            conf_rows.append((typ, q["qid"], res.lex_conf, res.sem_conf, res.abstained))
            if gold:
                rec["recall5"] = recall_at_k(gold, ranked, 5)
                rec["ndcg10"] = ndcg_at_k(gold, ranked, 10)
                rec["mrr"] = mrr(gold, ranked)
                rec["false_abstain"] = res.abstained
                for arm in ("bm25", "vector", "semble"):
                    r5 = recall_at_k(gold, B.baseline(q["query"], arm) if arm != "semble" else S.baseline(q["query"], "semble"), 5)
                    for key in keys:
                        baseline_hits[key][arm].append(r5)
            if typ == "id-lookup":
                ok = bool(res.hits) and res.hits[0].section.id == gold[0] and (not exp.get("anchor") or res.hits[0].anchor == exp["anchor"])
                rec["exact"] = ok
            if typ == "definition":
                rec["exact"] = bool(res.hits) and res.hits[0].section.id == gold[0] and (not exp.get("anchor") or res.hits[0].anchor == exp["anchor"])
            if typ == "cross-ref":
                need = set(gold) | set(q.get("context_required", []))
                got = set(ranked[:5]) | {e["id"] for h in res.hits[:5] for e in h.expanded}
                rec["context_recall5"] = len(need & got) / len(need)
            if typ in ("no-gold", "wrong-corpus"):
                rec["exact"] = res.abstained
            if typ == "negative":
                bad = set(q.get("must_not_top", []))
                top_expr = res.hits[0].section.expr if res.hits else None
                top_id = res.hits[0].section.id if res.hits else None
                rec["exact"] = bool(res.hits) and top_expr not in bad and top_id not in bad
            if typ == "overlay" and exp.get("op") == "overlay":
                st = corpus.overlay_status(exp["id"])
                rec["exact"] = st == exp["expected"]
            if typ == "table" and exp.get("op") == "table_lookup":
                rows = corpus.table_rows(exp["id"])
                row = next((r for r in rows if all(s.lower() in r.lower() for s in exp["row_contains"])), None)
                rec["exact"] = row is not None and exp["value"].lower() in row.lower()
            if typ == "amendment-history" and exp.get("op"):
                rec["exact"] = _structural(corpus, S, exp, q, latency)
        else:
            rec["exact"] = _structural(corpus, S, exp, q, latency)
        for key in keys:
            per_type[key].append(rec)
        failed = (rec.get("recall5") is not None and rec["recall5"] < 1.0) or (rec.get("exact") is False)
        if failed and kept:
            failures.append(rec)

    # ---- aggregate ----------------------------------------------------------------------
    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    summary = {}
    for typ in TYPE_ORDER:
        recs = per_type.get(typ, [])
        if not recs:
            continue
        summary[typ] = {
            "n": len(recs),
            "recall5": mean([r.get("recall5") for r in recs]),
            "ndcg10": mean([r.get("ndcg10") for r in recs]),
            "mrr": mean([r.get("mrr") for r in recs]),
            "exact": mean([float(r["exact"]) for r in recs if "exact" in r]) if any("exact" in r for r in recs) else None,
            "context_recall5": mean([r.get("context_recall5") for r in recs]),
            "false_abstain": mean([float(r["false_abstain"]) for r in recs if "false_abstain" in r]) if any("false_abstain" in r for r in recs) else None,
        }
    gate_locate = summary.get("locate", {}).get("recall5")
    gate_def = summary.get("definition", {}).get("recall5")
    passed = gate_locate is not None and gate_def is not None and gate_locate >= gate and gate_def >= gate

    # ---- report -------------------------------------------------------------------------
    st = corpus.stats()
    L = []
    L.append("# Milestone 0 results: chunking and ranking prototype on the fixture corpus\n")
    L.append(f"Generated {dt.datetime.now().isoformat(timespec='seconds')} on {platform.system()} {platform.release()}, Python {platform.python_version()}.\n")
    L.append("Command: `uv run --project proto sect-proto eval --corpus fixtures/corpus --questions eval/questions --out eval/results/m0.md --gate "
             f"{gate} --filter-rank {filter_rank}` (exit code 0 = gate passed)\n")
    L.append("## Gate\n")
    L.append("| Gate (spec F.1, milestone 0) | Threshold | Measured | Result |")
    L.append("|---|---|---|---|")
    L.append(f"| Recall@5, locate | >= {gate:.2f} | {pct(gate_locate)} | {'PASS' if gate_locate is not None and gate_locate >= gate else 'FAIL'} |")
    L.append(f"| Recall@5, definition | >= {gate:.2f} | {pct(gate_def)} | {'PASS' if gate_def is not None and gate_def >= gate else 'FAIL'} |")
    L.append(f"\n**Overall: {'PASS' if passed else 'FAIL'}.** Rust work may {'begin' if passed else 'not begin'} (spec F.1: gate before any Rust).\n")
    L.append("## Setup\n")
    L.append(f"- Corpus: `{corpus.root}`: {st['sources']} sources, {st['works']} Works, {st['expressions']} Expressions ({st['superseded']} superseded), "
             f"{st['actions']} Actions, {st['terms']} defined terms, {st['edges']} graph edges, {st['tables']} tables; {S.n} chunks (one per section file, split only above 2,000 tokens).")
    L.append(f"- Library: semble {_semble_version()} (BM25 index, model loading, chunk embedding, tokenizer, RRF baseline) + model2vec `{S.model_name}` (static embeddings, brute-force cosine).")
    L.append(f"- Chunk text: breadcrumb + `context` prefix + body (+ flattened table rows). Field weights for BM25: title 3, path 2, context 1.5, body 1, citations 3, terms_defined 4.")
    L.append(f"- Fusion: BM25 top-{100} + vector top-{100}, RRF k=60, lexical weight x2 for ID/term-like queries, then: citation short-circuit, definition resolution, title/path +0.10, hub boost log(1+refs_in)x0.02 (cap 0.10), notes -0.2, superseded filtered at as-of. Abstain when lexical overlap < {floor_lex} and cosine < {floor_sem}, or cosine < {floor_hard}.")
    L.append(f"- Index build (both arms, incl. model load): {index_ms:.0f} ms.\n")
    L.append("## Per-type results (prototype pipeline)\n")
    L.append("| Type | n | Recall@5 | NDCG@10 | MRR | Exact-match | Context Recall@5 (with --expand refs) | False abstention |")
    L.append("|---|---|---|---|---|---|---|---|")
    for typ, s in summary.items():
        L.append(f"| {typ} | {s['n']} | {pct(s['recall5'])} | {pct(s['ndcg10'])} | {pct(s['mrr'])} | {pct(s['exact'])} | {pct(s['context_recall5'])} | {pct(s['false_abstain'])} |")
    L.append("\nExact-match meaning by type: id-lookup = citation resolved to the right section and anchor at rank 1; definition = defining section at rank 1; "
             "subtree-completeness = `map --complete` returns exactly the expected set; as-of = snapped Expression equals expected (or the search top hit at that date); "
             "amendment-history = `read --history` / `refs --type amends` exact; overlay = `overridden_by` / `narrowed_by` exact; table = the flattened row lookup finds the value; "
             "no-gold / wrong-corpus = abstained; negative = the top hit is not the superseded or lower-precedence distractor.\n")
    L.append("## Baselines (Recall@5)\n")
    L.append("Non-contextual arms index the body only (no breadcrumb, no context prefix). `semble hybrid` is semble's own BM25+vector RRF (alpha auto, no code reranking) over the contextual chunk text.\n")
    L.append("| Type | n | BM25 only, body | Vector only, body | semble hybrid, contextual | Prototype pipeline |")
    L.append("|---|---|---|---|---|---|")
    for typ in TYPE_ORDER:
        if typ in baseline_hits and summary.get(typ, {}).get("recall5") is not None:
            b = baseline_hits[typ]
            L.append(f"| {typ} | {len(b['bm25'])} | {pct(mean(b['bm25']))} | {pct(mean(b['vector']))} | {pct(mean(b['semble']))} | {pct(summary[typ]['recall5'])} |")
    if filter_stats:
        L.append("\n## Cross-reference questions: CRAwLeR adversarial filter\n")
        L.append(f"Rank threshold {filter_stats['rank']} (spec default 10; fixture uses a smaller value because the corpus has ~{S.n} chunks, see spec-changes #5). "
                 f"{filter_stats['kept']} of {filter_stats['candidates']} author-written cross-ref questions survived; a question is dropped when the body-only BM25 or vector baseline already ranks the target at or above the threshold.\n")
        L.append("| qid | target | BM25 rank | vector rank | kept |")
        L.append("|---|---|---|---|---|")
        for r in filter_stats["rows"]:
            f = r["filter"]
            L.append(f"| {r['qid']} | {r['gold'][0]} | {f['baseline_bm25_rank']} | {f['baseline_vector_rank']} | {'yes' if f['kept'] else 'no'} |")
    L.append("\n## Latency\n")
    L.append("| Verb | n | p50 ms | p95 ms |")
    L.append("|---|---|---|---|")
    for verb, xs in sorted(latency.items()):
        xs_sorted = sorted(xs)
        p50 = statistics.median(xs_sorted)
        p95 = xs_sorted[min(len(xs_sorted) - 1, int(round(0.95 * (len(xs_sorted) - 1))))]
        L.append(f"| {verb} | {len(xs)} | {p50:.1f} | {p95:.1f} |")
    L.append("\n## Abstention calibration\n")
    L.append("Lexical overlap = fraction of the query's content words present in the top hit's chunk; cosine = model2vec similarity of the top hit.\n")
    L.append("| type | qid | lexical overlap | cosine | abstained |")
    L.append("|---|---|---|---|---|")
    for typ, qid, lc, sc, ab in conf_rows:
        if typ in ("no-gold", "wrong-corpus") or ab:
            L.append(f"| {typ} | {qid} | {lc:.2f} | {sc:.2f} | {'yes' if ab else 'no'} |")
    L.append("\n## Failures\n")
    if not failures:
        L.append("None.\n")
    else:
        L.append("| qid | type | query | top-5 | metric |")
        L.append("|---|---|---|---|---|")
        for r in failures:
            metric = f"recall5={pct(r.get('recall5'))}" if r.get("recall5") is not None else f"exact={r.get('exact')}"
            L.append(f"| {r['qid']} | {r['type']} | {r['query'][:90]} | {', '.join(r.get('top', []))} | {metric} |")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L[:12]))
    print(f"\nWrote {out}")
    return passed


def _structural(corpus: Corpus, S: Searcher, exp: dict, q: dict, latency) -> bool:
    op = exp.get("op")
    t0 = time.perf_counter()
    try:
        if op == "map_complete":
            got = corpus.map_complete(exp["id"], exp.get("anchor"))
            ok = got == exp["expected"]
            verb = "map"
        elif op == "as_of":
            sec = corpus.as_of(exp["id"], dt.date.fromisoformat(exp["date"]))
            ok = (sec.expr if sec else None) == exp["expected"]
            verb = "read --as-of"
        elif op == "as_of_search":
            res = S.search(q["query"], limit=5, as_of=dt.date.fromisoformat(exp["date"]))
            got = res.hits[0].section.expr if res.hits and not res.abstained else None
            ok = got == exp["expected"]
            verb = "search --as-of"
        elif op == "history":
            ok = corpus.history(exp["id"]) == exp["expected"]
            verb = "read --history"
        elif op == "refs":
            edges = corpus.refs(exp["id"], exp.get("direction", "out"), exp.get("type"), exp.get("depth", 1))
            key = "from" if exp.get("direction") == "in" else "to"
            got = sorted({e[key].split("@")[0] for e in edges})
            ok = got == sorted(exp["expected"])
            verb = "refs"
        elif op == "overlay":
            ok = corpus.overlay_status(exp["id"]) == exp["expected"]
            verb = "read (overlay flags)"
        elif op == "define":
            ok = corpus.define(exp["term"]) == tuple(exp["expected"])
            verb = "define"
        else:
            return False
    except Exception as e:  # noqa: BLE001
        print(f"structural op {op} failed for {q.get('qid')}: {e}")
        return False
    latency[verb].append((time.perf_counter() - t0) * 1000)
    return bool(ok)


def _semble_version() -> str:
    try:
        from importlib.metadata import version

        return version("semble")
    except Exception:  # noqa: BLE001
        return "?"
