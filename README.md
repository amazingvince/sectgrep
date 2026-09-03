# sectgrep

`sect` is a single-binary search and navigation tool over a structured markdown corpus of rules and guidelines, built for AI agents: exact, lexical, semantic, and structural retrieval behind seven verbs (`search`, `grep`, `read`, `refs`, `define`, `map`, `status`) over CLI and MCP. This repository also holds `sect-convert` (preprocessing and validators) and the ingest harness that fills a corpus without ever writing to it directly.

**Status:** milestones 0 through 5 done (2026-09-03). The E.1 gates pass on the fixture question set: Recall@5 0.95 locate and 1.00 definition, exact-match 1.00 on id-lookup, refs, as-of, and map --complete, abstention 1.00 on no-gold ([eval/results/m5.md](eval/results/m5.md)). `sect grep` runs on ripgrep's crates with rg-compatible flags and output ([eval/results/m3.md](eval/results/m3.md)); `sect search` fuses a tantivy BM25 index with model2vec embeddings (RRF k=60) and answers 50 queries on two converted eCFR titles with a p95 of 240 ms ([eval/results/m4.md](eval/results/m4.md)). The eCFR XML half of the converter (C1) shipped early as `packages/sect-convert`. The milestone-0 gate passed (locate Recall@5 0.95, definition 1.00, [eval/results/m0.md](eval/results/m0.md)); the fork-or-borrow decision is in [docs/decisions.md](docs/decisions.md) 15a; the Rust binary indexes the fixture into `tree.json`, `xrefs.jsonl`, `actions.jsonl`, `terms.json`, and `tables.jsonl`, and answers `read`, `map`, `refs`, `define`, and `status`, with `--as-of` snapping, `--history`, `map --complete`, and overlay markers inline. Exact-match on the fixture is 1.00 for refs, define, as-of, and map --complete ([eval/results/m2.md](eval/results/m2.md)). Next: milestone 6 (fingerprint-driven incremental indexing, background rebuilds, `--freshness wait`), then C0 and the rest of C1 on the converter track. Nothing is published yet.

## Build and run

```
cargo build --release
target/release/sect index fixtures/corpus
target/release/sect read CFR:99-2.7 --corpus fixtures/corpus --ancestors
target/release/sect map --scope CFR:99-2 --depth 1 --corpus fixtures/corpus
target/release/sect status --corpus fixtures/corpus
target/release/sect index --validate-only fixtures/corpus
target/release/sect refs CFR:99-2.8 --direction in --corpus fixtures/corpus
target/release/sect refs CFR:99-2.7 --direction in --type references --as-of 2025-06-01 --corpus fixtures/corpus
target/release/sect define "qualified person" --usages --scope CFR:99-2 --corpus fixtures/corpus
target/release/sect map --complete --scope "CFR:99-2.13#c" --corpus fixtures/corpus
target/release/sect read CFR:99-2.7 --history --as-of 2025-06-01 --corpus fixtures/corpus
target/release/sect read "CFR:99-1.4#b" --corpus fixtures/corpus
target/release/sect grep -i -w "cage" -C 1 --corpus fixtures/corpus
target/release/sect grep --annotate "48 inches" --corpus fixtures/corpus
target/release/sect grep -c employer --scope CFR:99-3 --corpus fixtures/corpus
target/release/sect grep "the" --max-hits 50 --corpus fixtures/corpus     # over the bound: per-file counts and a note
```

`grep` takes the common ripgrep flags (`-i -w -F -e -g -n -N -c -l -A -B -C`) and prints what ripgrep prints, after the two header lines. It is exhaustive and bounded: past `--max-hits` (default 200) it answers with per-file counts and asks you to narrow.

```
target/release/sect search "toeboard height at a guardrail" --corpus fixtures/corpus
target/release/sect search "fixed ladder cage requirement" --as-of 2025-06-01 --corpus fixtures/corpus
target/release/sect search "guardrail" --kind overlay --fts --corpus fixtures/corpus
target/release/sect index --embedding none fixtures/corpus     # lexical only, no model download
```

`search` fuses BM25 (tantivy, fielded per spec B.4) with static embeddings (model2vec `potion-retrieval-32M`) by reciprocal rank fusion, applies the spec's signal table, and returns one hit per section, at most 50. A citation-shaped query (`99 CFR 2.8`, `§ 1.5(a)(2)`) short-circuits to the section itself; a define-shaped query (`what is a hole`) goes to the defining section and paragraph. The model is fetched from the Hugging Face hub at index time and copied into `.sect/semantic/model/`, so queries never touch the network. `--fts` and `--vector` run one leg; `--scope`, `--source`, `--kind`, `--as-of`, and `--include-superseded` filter before ranking.

```
target/release/sect search "duty to have fall protection" --expand refs --corpus fixtures/corpus
target/release/sect search "ladders and fall protection" --seed --budget 600 --corpus fixtures/corpus
target/release/sect search "respirator fit testing" --corpus fixtures/corpus     # abstains, names the nearest scope
```

Every verb stats the corpus before answering (parallel stat of the tracked files plus the directory mtimes that reveal additions and removals). A fresh index answers at once; a small change set is re-indexed inside the query; a large one is answered `possibly_stale (N changed)` while a detached `sect index` rebuilds it. `--freshness wait` always rebuilds first, `--freshness no` (or `--no-refresh`) answers as-is, and `SECT_SYNC_LIMIT` moves the small/large boundary (default 20 files). `sect index` itself is incremental: it re-parses only files whose blake3 changed, replaces their chunks in tantivy and `vectors.bin`, and does nothing at all when nothing changed. `--full` rebuilds everything.

`--expand refs` appends the sections each hit references so a cross-reference answer is complete in one call; `--expand ancestors` appends the chain above each hit. `--seed --budget N` returns a lexical-heavy top-k as a compact block under N tokens for one-time injection at the start of an agent session. When nothing clears the confidence floor the answer says so, gives the nearest scope, and marks the hits as candidates rather than an answer.

## Converting a real title (WS2, eCFR XML)

```
pnpm install
pnpm --filter @sectgrep/convert convert fetch --title 1 --out "$PWD/raw"
pnpm --filter @sectgrep/convert convert ecfr --xml "$PWD/raw/cfr-title-1/<date>/ECFR-title1.xml" --title 1 --out "$PWD/corpora/ecfr"
target/release/sect index --validate-only corpora/ecfr
target/release/sect search "how to cite the Federal Register" --corpus corpora/ecfr
```

Titles 1 and 4 (510 sections) convert into the B.2 contract with zero validation errors. `raw/` and `corpora/` are gitignored; the fixture stays in the repository.

Every answer starts with a freshness line and a counts line. `--json` puts `freshness` and `counts` first. A query on a changed corpus rebuilds the index first and says so; `--no-refresh` answers from the index as it is and says `possibly_stale`.

- Roadmap and definition of done: [GOAL.md](GOAL.md)
- Specification: [sectgrep-spec-v0.4.md](sectgrep-spec-v0.4.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- Proposed spec changes: [docs/spec-changes.md](docs/spec-changes.md)

## Layout

```
crates/      Rust workspace for `sect`: sect-core, sect-corpus, sect-struct, sect-index, sect-query,
             sect-format, sect-cli (real); sect-exact, sect-ngram, sect-lexical, sect-semantic,
             sect-rank, sect-mcp (stubs naming their milestone)
packages/    sect-convert (TypeScript: eCFR XML native parser today; PDF/DOCX/HTML/XLSX, OCR, and the
             validators at C1/C2) and, later, the ingest harness
proto/       Milestone-0 Python prototype (semble); throwaway, never shipped
eval/        Question sets, golden data, and per-milestone results
fixtures/    Synthetic corpus for CI (spec B.2 contract)
docs/        Decisions, spec-change proposals, agent SKILL files
```

## Milestone-0 prototype

```
uv sync --project proto
uv run --project proto sect-proto validate fixtures/corpus
uv run --project proto sect-proto eval --corpus fixtures/corpus --questions eval/questions --out eval/results/m0.md --gate 0.85 --filter-rank 3
```

See [proto/README.md](proto/README.md).

## Name

The project and crate are `sectgrep`; the binary is `sect`. `sect` alone is taken on crates.io by an unrelated library, so install with `cargo install sectgrep` once R1 is published. The registry check and the decision are in `docs/decisions.md` entry 14a.

## License

Apache-2.0. See [LICENSE](LICENSE).
