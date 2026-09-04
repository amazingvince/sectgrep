# sectgrep

`sect` is a single-binary search and navigation tool over a structured markdown corpus of rules and guidelines, built for AI agents: exact, lexical, semantic, and structural retrieval behind seven verbs (`search`, `grep`, `read`, `refs`, `define`, `map`, `status`) over CLI and MCP. This repository also holds `sect-convert` (preprocessing and validators) and the ingest harness that fills a corpus without ever writing to it directly.

**Status:** milestones 0 through 7, 3b, C0, C1 and C2 done (2026-09-03); release R2 tagged `v0.2.0` (R1 was `v0.1.0`). The E.1 gates pass on the fixture question set: Recall@5 0.95 locate and 1.00 definition, exact-match 1.00 on id-lookup, refs, as-of, and map --complete, abstention 1.00 on no-gold ([eval/results/m5.md](eval/results/m5.md)). Indexing is incremental and every query stats the corpus first: about 5 ms for 10k files on Linux, about 70 ms on NTFS ([eval/results/m6.md](eval/results/m6.md)). `sect grep` runs on ripgrep's crates with rg-compatible flags and output ([eval/results/m3.md](eval/results/m3.md)); `sect search` fuses a tantivy BM25 index with model2vec embeddings (RRF k=60) and answers 50 queries on two converted eCFR titles with a p95 of 240 ms ([eval/results/m4.md](eval/results/m4.md)). The converter (C1) covers eCFR XML, Federal Register XML with Action candidates, born-digital PDF/DOCX/HTML/XLSX elements with the C.4 passes, and a dual-transcriber scan path; a full Title 29 and six notices validate with 0 errors ([eval/results/c1.md](eval/results/c1.md)). The seven C.5 validators run as `sect-convert validate` on staging and in CI on the fixture, and `sect-convert align` diffs two versioner dates of a title ([eval/results/c2.md](eval/results/c2.md)). The milestone-0 gate passed (locate Recall@5 0.95, definition 1.00, [eval/results/m0.md](eval/results/m0.md)); the fork-or-borrow decision is in [docs/decisions.md](docs/decisions.md) 15a; the Rust binary indexes the fixture into `tree.json`, `xrefs.jsonl`, `actions.jsonl`, `terms.json`, and `tables.jsonl`, and answers `read`, `map`, `refs`, `define`, and `status`, with `--as-of` snapping, `--history`, `map --complete`, and overlay markers inline. Exact-match on the fixture is 1.00 for refs, define, as-of, and map --complete ([eval/results/m2.md](eval/results/m2.md)). Milestone 7 adds the MCP server, `sect install`, and the agent examples; release R1 is the tag `v0.1.0` (no registry publish). The ingest harness (H1) runs a Pi agent with the seven verbs and six harness tools over WS2's output into `staging/<run_id>/`, validates, and submits; a live run over Title 4 is measured in [eval/results/h1.md](eval/results/h1.md). Next: H2, verification and commit.

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

`sect grep` can run behind a sparse n-gram prefilter: `sect index --ngram on` builds `.sect/ngram/` (corpus-derived byte-pair weights, 4-byte grams at positions the weights select, roaring postings per gram behind an mmap'd table), and grep then reads only the files that can contain the literals a pattern requires, verifying every candidate with the real matcher. Under `--ngram auto` (the default) the layer exists only for corpora of 200 MB and more; `grep --no-index` forces the brute-force scan. Kept on the measured gate: outputs identical to brute force, median in-process speedup 199x on NTFS and 75x on ext4 for the three converted titles, 6.3x and 3.2x wall ([eval/results/m3b.md](eval/results/m3b.md), decisions #6).

`--expand refs` appends the sections each hit references so a cross-reference answer is complete in one call; `--expand ancestors` appends the chain above each hit. `--seed --budget N` returns a lexical-heavy top-k as a compact block under N tokens for one-time injection at the start of an agent session. When nothing clears the confidence floor the answer says so, gives the nearest scope, and marks the hits as candidates rather than an answer.

## Install and use from an agent (MCP)

```
cargo build --release
target/release/sect install --corpus corpora/ecfr                       # copies the binary, registers with Claude Code
target/release/sect install --corpus corpora/ecfr --client claude-desktop --client cursor
target/release/sect install --corpus corpora/ecfr --project --dry-run   # shows the .mcp.json it would write
target/release/sect serve --corpus corpora/ecfr                         # MCP over stdio (what clients run)
target/release/sect serve --corpus corpora/ecfr --http 127.0.0.1:7999   # streamable HTTP at /mcp, loopback only
target/release/sect serve --corpus corpora/ecfr --toolset full          # adds sect_index and sect_rebuild
```

The MCP server exposes `sect_search`, `sect_grep`, `sect_read`, `sect_refs`, `sect_define`, `sect_map`, and `sect_status` with the same arguments as the CLI: the schemas are generated from the definitions the CLI parses (`crates/sect-verbs`). Each result carries the CLI text and the `--json` value as structured content. [docs/SKILL.md](docs/SKILL.md) tells an answering agent which verb to use when and where ranking stops and guarantees begin. [examples/pi](examples/pi) wraps the tools as Pi `AgentTool`s and [examples/claude-agent-sdk](examples/claude-agent-sdk) registers the server with the Claude Agent SDK; both call all seven verbs in their tests without an API key, and both run a real agent when `ANTHROPIC_API_KEY` is set. Nothing is published to a registry: install is a copy plus a config entry.

## OCR and the transcriber boundary (WS2, milestone C0)

`packages/sect-convert/src/ocr/` is the converter's transcriber boundary: one OpenAI-compatible backend that talks to a local vLLM server today and to a hosted API by base URL and key later, per-model presets with the documented prompts and page scales, a renderer that scales each page to the model's target (floored by DPI for born-digital text, capped at 3 MP, never upsampled past a scan's native DPI), and a repetition guard that retries a looping reply once with a frequency penalty. `sect-convert ocr --pdf F --page N --server http://127.0.0.1:8000/v1 --model PaddlePaddle/PaddleOCR-VL-1.5` transcribes one page through it.

The milestone-C0 bake-off ([eval/results/c0.md](eval/results/c0.md), harness in [packages/sect-convert/bakeoff](packages/sect-convert/bakeoff)) ran Docling, Marker, PaddleOCR-VL-1.5, GLM-OCR and olmOCR-2 on 30 documents with local vLLM inference and chose PaddleOCR-VL-1.5's pipeline as primary transcriber and olmOCR-2's as secondary ([docs/decisions.md](docs/decisions.md) #38). Milestone C1 then moved the scanned-page path to the API pair, olmOCR-2 primary and GLM-OCR secondary as whole-page requests, because production will call a hosted API (#39); `bakeoff/scripts/serve-pair.sh` serves both locally.

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

## Extracting documents (WS2, milestone C1)

`sect-convert extract --input F [--work DIR] [--source-yaml Y --title N] [--ocr-server URL/v1 --ocr-secondary-server URL/v1] [--images] [--force]` turns one raw document (born-digital or scanned PDF, DOCX, HTML, XLSX) into `work/<raw_sha256>/`: `elements.jsonl` (the C.3 element rows: type, text, bbox, font size, bold, flags, confidence), `report.json`, page images, `grids.jsonl` for spreadsheets, and the C.4 pass outputs `structure.json`, `xrefs_candidates.jsonl`, `terms_candidates.json`. Runs are cached by input hash. A page without a text layer goes to both transcribers; lines they agree on are accepted, the rest are flagged `ocr_divergent` with the other reading in `alt_text`, and both raw readings are kept under `ocr/`. Without `--ocr-server` scanned pages are flagged `no_text_layer`, not read.

Federal Register rules: `sect-convert fr-fetch --title 29 --count 6 --out raw` pulls the newest rules touching a title into `raw/fr/<year>/`, and `sect-convert fr --xml raw/fr --out corpora/ecfr` writes notice files with Action candidates (target id, anchor, kind, effective, text) parsed from the amendatory instructions. The eCFR converter now also writes EFFDNOT and CROSSREF candidates under `corpora/ecfr/.work/`.

## Validating staging and aligning versions (WS2, milestone C2)

`sect-convert validate <staging> [--corpus ROOT] [--raw-root DIR] [--work DIR] [--sect BIN] [--skip-index] [--json]` runs the seven spec C.5 validators over a staging directory in the B.2 layout and exits 1 on any error: (1) the sect binary's contract check, (2) the round-trip text check against the section's own raw source (extracted elements under `work/`, or the XML node named by the locator) at 0.92 token level, with the context block required to stay below 0.8 similarity to the body, (3) table cells against the source grid, (4) link targets that exist and are active at the section's effective date, with anchors, (5) provenance completeness with the raw hash checked against the file, (6) overrides and narrows targets that are base-kind and lower precedence, (7) every `amended_by` Action present, aimed at this section, with its quoted text in the new Expression. `--corpus` names the corpus the staging will join, so links across the two resolve. The same library is importable from `@sectgrep/convert`.

`sect-convert align cfr-title-N <old> <new> [--out changes.json] [--raw-root raw]` matches the nodes of two versions of a title by node, then id, then title, then text, and writes `changes.json` (unchanged, changed with a line diff, renumbered, moved, added, removed). A version is a date, fetched from the eCFR versioner and cached under `raw/`, or a local XML path.

The fixture corpus carries its own raw sources (`fixtures/raw/`, `fixtures/work/`, generated by `packages/sect-convert/scripts/make-fixture-raw.mjs`), so CI validates it with all seven.

## Ingesting a source (WS3, milestone H1)

`sect-harness ingest --input <WS2 output dir> --source <name> --corpus <root> [--staging staging] [--sect BIN] [--concurrency 4] [--limit N] [--dry-run]` runs the Ingest agent ([docs/SKILL-ingest.md](docs/SKILL-ingest.md)) over one converted source: for each section the agent writes the context prefix, resolves bare references with `sect_search`, lists the terms defined, and calls `section_stage`, which copies the body and applies those fields; the harness then runs the seven validators, re-prompts the agent on errors up to three times, and writes `staging/<run_id>/submit.json`. Writes outside the run's staging directory are refused by the `beforeToolCall` hook and by the tools. Runs are idempotent per raw hash and serialized per source. The model comes from `.env` (see Configuration); `--dry-run` stages with WS2's context and no model. The container is `packages/sect-harness/Dockerfile`.

## Configuration and keys

Hosted-model settings come from the shell or the nearest `.env` file (gitignored; copy [.env.example](.env.example)): `SECT_MODEL_PROVIDER` (default `openrouter`), `SECT_MODEL_BASE_URL`, `SECT_MODEL` (default `z-ai/glm-5.3-flash`, what OpenRouter's `~z-ai/glm-flash-latest` alias resolves to), `SECT_MODEL_NO_RETENTION` (set to 1 to route only to providers that keep no prompts), and the provider's key variable, `OPENROUTER_API_KEY`. The converter reads them for the scanned-page secondary on the API path, and the Pi example and the ingest harness read them for their agent model. Keys never go in the repository; the transcriber pair for scans can also be pointed at any OpenAI-compatible server with `SECT_OCR_SERVER`, `SECT_OCR_SECONDARY_SERVER`, `SECT_OCR_PRIMARY`, `SECT_OCR_SECONDARY` and `SECT_OCR_API_KEY`, or the matching `sect-convert extract` flags ([docs/decisions.md](docs/decisions.md) #41).

## Layout

```
crates/      Rust workspace for `sect`: sect-core, sect-corpus, sect-struct, sect-index, sect-query,
             sect-format, sect-cli (real); sect-exact, sect-ngram, sect-lexical, sect-semantic,
             sect-rank, sect-mcp (stubs naming their milestone)
packages/    sect-convert (TypeScript: eCFR and Federal Register parsers, PDF/DOCX/HTML/XLSX elements, the OCR path, and the
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
