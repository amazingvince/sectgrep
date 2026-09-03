# `sect-proto`: milestone-0 chunking and ranking prototype

Throwaway Python prototype for spec milestone 0 (F.1): validate the chunking and ranking design of spec B.4 on the fixture corpus **before any Rust is written**. It is never shipped or published. The only Python in the program.

Gate: **Recall@5 >= 0.85 on locate and definition questions.** Results: [`eval/results/m0.md`](../eval/results/m0.md).

## Run

From the repository root:

```
uv sync --project proto
uv run --project proto sect-proto validate fixtures/corpus
uv run --project proto sect-proto eval --corpus fixtures/corpus --questions eval/questions --out eval/results/m0.md --gate 0.85 --filter-rank 3
```

`eval` exits 0 when the gate passes and 1 when it fails. The first run downloads `minishlab/potion-retrieval-32M` (MIT) into `proto/.hf-cache/`. All caches (`uv`, Hugging Face) live inside the checkout, so a run touches nothing outside the repository.

Other verbs, useful for poking at the fixture:

```
uv run --project proto sect-proto search fixtures/corpus "toeboard height" --expand refs
uv run --project proto sect-proto search fixtures/corpus "fixed ladder cage" --as-of 2025-06-01
uv run --project proto sect-proto search fixtures/corpus "exit width" --baseline bm25
uv run --project proto sect-proto read fixtures/corpus CFR:99-2.7 --as-of 2025-06-01
uv run --project proto sect-proto map fixtures/corpus CFR:99-2.13 --anchor c
uv run --project proto sect-proto refs fixtures/corpus CFR:99-2.8 --direction in
uv run --project proto sect-proto history fixtures/corpus CFR:99-2.7
uv run --project proto sect-proto define fixtures/corpus "first aid"
uv run --project proto sect-proto crossref-candidates fixtures/corpus --out eval/questions/crossref.candidates.jsonl
uv run --project proto sect-proto filter fixtures/corpus --questions eval/questions --rank 3
```

## What is borrowed from semble and what is local

The spec names [`semble`](https://github.com/MinishLab/semble) (MinishLab, MIT) as the prototype library. It is a code-search library: static model2vec embeddings plus BM25, fused with RRF. The prototype uses its building blocks rather than its file walker, because the spec's chunk is a section file with a breadcrumb and a context prefix, not a tree-sitter code chunk.

| Piece | Source |
|---|---|
| BM25 inverted index (`semble.index.bm25.BM25`), one per field | semble |
| Model loading and chunk embedding (`semble.index.dense`), model2vec `potion-retrieval-32M` | semble, model2vec |
| Tokenizer for text fields (`semble.tokens.tokenize`) | semble |
| Plain hybrid baseline arm (`semble.search.search`, RRF k=60, no code reranking) | semble |
| Chunk text = breadcrumb + `context` + body (+ flattened table rows); split only above 2,000 tokens at paragraph labels | local (spec B.2, B.4) |
| Field weights: title 3, path 2, context 1.5, body 1, citations 3, terms_defined 4; citation tokenizer that keeps `2.8`, `am-1`, `2026-00001` whole | local (spec B.4) |
| Fusion: BM25 top-100 + cosine top-100, RRF k=60, lexical weight x2 for ID/term-like queries | local (spec B.4) |
| Signals: citation short-circuit via `id_pattern`, definition resolution via `terms`, title/path +0.10, hub boost, notes -0.2, superseded filtered at `--as-of` or -0.5, one hit per section | local (spec B.4) |
| Structural graph: tree, xrefs, Actions, terms, tables, `overridden_by` / `narrowed_by`, Work / Expression / Action with as-of snapping | local (spec B.2, B.4) |
| Abstention: below a lexical-overlap and cosine floor, answer "not found" with the nearest scope | local (spec B.3) |
| CRAwLeR cross-ref candidates and adversarial filter | local (spec E.1) |

`bm25s` and `PyStemmer` are listed as dependencies for experiments but the reported pipeline uses semble's BM25 so the lexical leg matches what `semble_rs` offers for the fork-or-borrow decision at milestone 0.5.

## Layout

```
sect_proto/corpus.py     B.2 loader and structural graph (tree, xrefs, Actions, terms, tables, versioning)
sect_proto/index.py      Searcher: fielded BM25 + model2vec cosine + RRF + signals; baseline arms
sect_proto/questions.py  CRAwLeR candidates and adversarial filter; JSONL helpers
sect_proto/validate.py   contract check (the prototype's `sect index --validate-only`)
sect_proto/evaluate.py   E.1 metrics per question type; writes the markdown report
sect_proto/cli.py        `sect-proto` entry point
```

## Knobs

| Flag | Default | Meaning |
|---|---|---|
| `--gate` | 0.85 | Recall@5 threshold for locate and definition |
| `--filter-rank` | 10 | CRAwLeR filter: drop a cross-ref question if a body-only BM25 or vector baseline ranks the target at or above this rank. The fixture run uses 3 because the corpus has ~45 chunks (spec-changes #5). |
| `--refilter` | off | Recompute `crossref.filtered.jsonl` even if it exists |
| `--floor-lex`, `--floor-sem` | 0.34, 0.45 | Abstention floors: lexical overlap of query content words with the top hit, and top cosine |
| `SECT_PROTO_MODEL` | `minishlab/potion-retrieval-32M` | Embedding model (any model2vec model) |

## What this prototype does not do

No incremental indexing, no n-gram prefilter, no `grep`, no MCP, no seed budget. Those are Rust milestones. Nothing here is on the shipping path; the Rust crates are written against the spec, and the fork-or-borrow decision at milestone 0.5 decides whether `semble_rs` is vendored or reimplemented.
