# Decisions log

Continues the decisions log in `sectgrep-spec-v0.4.md` Part F.3. Entries 1-15 are carried from the spec and are not reopened without a proposal in `spec-changes.md`. New entries are appended below with the date and the milestone that made them.

## Carried from the spec (F.3)

| # | Question | Decision | Status |
|---|---|---|---|
| 1 | Scanned material | In scope from v1; dual-transcriber OCR. | Spec |
| 2 | Overlay formats | Spreadsheet and PDF paths from v1. | Spec |
| 3 | Overlay semantics | `overrides` and `narrows` both from v1. | Spec |
| 4 | Embedding model | `potion-retrieval-32M` via `model2vec-rs`; no distillation; contextual prefixing instead of late chunking. | Spec |
| 5 | Verifier | Answer-blind, different provider; measured vs golden labels before H2. | Spec |
| 6 | Indexed regex | Sparse n-grams with corpus-derived weights (3b), gated on measured speedup. | Spec; keep/cut recorded at 3b |
| 7 | Federation | Single root. | Spec |
| 8 | Reference corpus | eCFR + Federal Register; XML flagged `unofficial-xml` in provenance. | Spec |
| 9 | Harness | Pi (`pi-agent-core`) primary; Claude Agent SDK via the MCP surface. | Spec |
| 10 | License | Apache-2.0. | Spec |
| 11 | Languages | Rust for `sect`; TypeScript for WS2/WS3; Docling and OCR models as subprocesses. | Spec |
| 12 | Chunk unit | Section/subsection file; split only at paragraph labels. | Spec |
| 13 | Versioning | Work / Expression / Action; `--as-of` snaps, current-only default. | Spec |
| 14 | Name | `sectgrep` / `sect`, pending registry check; fallback `regsift`. | **Decided 2026-09-03: keep `sectgrep` / `sect`** (see 14a) |
| 15 | Retrieval core | Fork-or-borrow decision (0.5) against `zg` and `semble_rs` before writing. | Pending, milestone 0.5 |

## Open questions resolved with the human before milestone 2 (2026-09-03)

| # | Question | Decision |
|---|---|---|
| 23 | Order of work | Stay on the Rust track: milestone 2 (structure) next, then C0/C1. The converter (C1) must land before milestone 4 so `search` is measured on a real title. |
| 24 | Compute | This machine has two NVIDIA GPUs available under WSL2: an RTX 5090 (32 GB) and an RTX 4090 (24 GB). The OCR bake-off (C0), any VLM transcription, and any embedding experiments run inside WSL2 in Docker with CUDA. No paid vision API arm unless asked again; hosted inference is not needed. |
| 25 | Remote | Public GitHub repository `amazingvince/sectgrep`, Apache-2.0, created 2026-09-03 with `main` pushed; CI runs on Linux there. Nothing is published to a package registry until R1. |
| 26 | Spec-change proposals | `spec-changes.md` #1 to #8 stay proposals; the code follows them. The human folds them into spec v0.5 at review time. #8 (`zg` is TypeScript) is the one that changes a spec claim. |
| 27 | Real corpus for evaluation | Start with two small eCFR titles for speed (Title 1 General Provisions, Title 4 Accounts), add Title 29 for the scaling arm in E.3. Fetched by script into `raw/`, never committed. |
| 28 | Question generation on the real corpus | Cross-reference questions are written in-session by the assistant following the CRAwLeR recipe (no API spend); the set is capped at a few hundred. Reopen if a larger set is needed. |
| 29 | Model weights for `sect-semantic` | Fetched at index time into the standard Hugging Face cache with a local-path override (`sect index --embedding <path-or-repo>`); never at query time. |
| 30 | `kind: internal` | Treated as an overlay kind with precedence above base and below local law until the spec defines it; flagged in `spec-changes.md` when it first matters. |
| 31 | Abstention | Revisit at milestone 5 with a score-margin or leg-agreement feature; do not tune the floors on the fixture (wrong-corpus 0.60, no-gold 1.00). |

## 15a. Fork-or-borrow: what was read in `zg` and `semble_rs` (milestone 0.5, 2026-09-03)

Read at `zvec-ai/zvec-grep` commit 899929f (2026-09-03) and `johunsang/semble_rs` commit 8f8d963 (2026-06-02), both cloned in full.

**Correction to spec A.2 item 10, H.8, and F.1 milestone 0.5: `zg` is not Rust.** `@zvec/zvec-grep` 0.2.1 is a TypeScript project for Node 22 or newer: 130 `.ts` files and no Cargo manifest anywhere in the tree. Its dependencies are `@zvec/zvec` (the vector store), `@vscode/ripgrep` (a managed ripgrep binary that it spawns for exact and regex search), `@modelcontextprotocol/*`, `web-tree-sitter`, and `@huggingface/transformers` for embeddings. Nothing in it can be vendored into a Rust crate. What it offers is design: one engine behind both the CLI and an MCP server with an "auto / server / direct" router, a per-workspace index directory (`.zvec-grep/`), "indexed search (BM25 + vector + RRF) plus managed ripgrep for exact text", and eight short docs (agents, CLI, MCP, pipeline, architecture, server, embedding, roadmap). Its exact-search mechanism, spawning `rg`, is what spec B.4 rules out ("never shell out"); the workflow it demonstrates, find by meaning then verify with exact text, is what `sect grep` exists for.

**`semble_rs`** (johunsang; `license = "MIT"` in `Cargo.toml`, but no LICENSE file in the tree, so confirm before copying any line): a Rust port and superset of MinishLab/semble for code search, 7.6k lines, 8 test modules. The pieces that overlap with `sect`:

| File | What it is | Size |
|---|---|---|
| `src/bm25.rs` | In-memory BM25 (`HashMap` postings, k1/b, `get_scores` with an optional weight mask). One field, no persistence. | 95 lines |
| `src/encoder.rs` | `StaticEncoder` over `model2vec-rs` 0.2.0 (default `potion-code-16M`) and `SemanticIndex`: normalized `ndarray` matrix, brute-force cosine top-k. | 103 lines |
| `src/search.rs` | `rrf_scores` with k = 60; `search_hybrid` combining the two legs with an alpha (0.3 for symbol-like queries, 0.5 for natural language); a `MIN_SCORE_RATIO` 0.12 cutoff. | 273 lines |
| `src/ranking/` | Code-specific reranking: multi-chunk file boost, path penalties, identifier boosts. | small |
| `src/tokens.rs` | Identifier splitting (camelCase, snake_case). | 120 lines |

Everything else (tree-sitter chunking for 12 languages, dependency graph, digest, outline, tree) is code-specific. The index is rebuilt in memory on every invocation: there is no on-disk index format to borrow.

**Per-crate decision:**

| Crate | From `zg` | From `semble_rs` | Decision | Why |
|---|---|---|---|---|
| `sect-lexical` | nothing (TypeScript) | 95-line single-field in-memory BM25 | **Depend on `tantivy` 0.26; reimplement the schema** | Spec B.4 needs fielded boosts, a `citations` field, facets, date filtering, and an on-disk segment format. `semble_rs`'s BM25 has none of those, and it is the same algorithm the prototype ran through Python semble, so the milestone-0 numbers carry over to tantivy's BM25 up to tokenization (decisions #18). |
| `sect-semantic` | transformers.js embeddings, not portable | `StaticEncoder` + `SemanticIndex` pattern on model2vec-rs 0.2.0 and ndarray 0.15 | **Depend on `model2vec-rs` 0.3 directly; reimplement the brute-force cosine leg behind an `EmbeddingProvider` trait** | Borrowing 100 lines would pin an older model2vec-rs and pull in ndarray. The pattern (normalized f32 matrix, dot product, top-k) is what the spec wants and is short to write together with `vectors.bin` persistence, which `semble_rs` lacks. |
| `sect-rank` | RRF and reranking in TypeScript | `rrf_scores`, alpha resolution, code boosts | **Reimplement; use the `rrf` crate as the spec names** | Alpha and the boosts are tuned for code (paths, identifiers, multi-chunk files). The prototype's signal table with its score scale (decisions #20) is the reference; only the RRF idea transfers. |
| `sect-exact`, `sect-ngram` | spawns a managed ripgrep | none | **Reimplement on the `grep-*` crates** (already decided in B.4) | `zg` confirms the value of the workflow but not the mechanism. |
| `sect-mcp` | MCP server, router, tool shapes (`docs/03-mcp.md`, `05-architecture.md`) | none | **Reimplement on `rmcp`; read `zg`'s MCP and architecture docs first at milestone 7** | Tool naming and the auto/server/direct router are the reusable ideas. |

Net result: no vendoring, no new dependencies beyond what B.7 lists, and one spec correction (spec-changes #8).

## 14a. Registry name check (bootstrap, 2026-09-03)

Run from this machine; nothing was published.

| Registry | `sectgrep` | `sect` | `regsift` | Method |
|---|---|---|---|---|
| crates.io | free | **taken**: `sect` 0.1.0, "a library for RFC 6962 Certificate Transparency" | free | `cargo search <name>` |
| npm | free (E404) | free (E404) | free (E404) | `npm view <name> version` |
| PyPI | free (404) | **taken** (200) | free (404) | `GET https://pypi.org/pypi/<name>/json` |
| Homebrew (formula and cask) | free | free | free | `GET https://formulae.brew.sh/api/{formula,cask}/<name>.json` |

**Finding.** `sectgrep` is clean on all four registries. `sect` collides on crates.io and PyPI.

**Analysis.** The spec rule is "fall back to `regsift` if either collides." Read literally, `sect` collides. In practice:

- The crates.io collision affects only the *crate* name. The project crate can be published as `sectgrep` and still install a binary named `sect` (`cargo install sectgrep` puts `sect` on PATH). The `sect_` MCP prefix and the `.sect/` index directory are unaffected.
- The PyPI collision is moot: no Python is shipped (spec A.1), and the milestone-0 prototype is never published.
- Homebrew and npm are clean, so `brew install sectgrep` and an npm wrapper are both available.

**Options.**

- (A) Keep `sectgrep` / `sect`. Publish the crate as `sectgrep`, binary `sect`. Accept that a `cargo install sect` typo resolves to an unrelated crate.
- (B) Follow the spec literally: project and binary `regsift`, MCP prefix `regsift_`, index dir `.regsift/`.

**Decision (human, 2026-09-03): option A.** The project and crate are `sectgrep`, the binary is `sect`, the MCP prefix is `sect_`, and the index directory is `.sect/`. The crate is published as `sectgrep` when R1 ships; `cargo install sectgrep` installs `sect`. The `regsift` fallback is retired.

## Milestone 0 (2026-09-03)

| # | Question | Decision |
|---|---|---|
| 16 | Prototype library | `semble` 0.5.5 (MinishLab, MIT) as the spec names it. It is a code-search library on `model2vec` + `vicinity` with BM25 + vector RRF. The prototype uses its BM25 index (one per field), its model loading and chunk embedding, its tokenizer, and its plain hybrid search as a comparison arm; it adds the spec's chunk text, field weights, signals, structural graph, and stemming + stopword removal locally. See `proto/README.md`. |
| 17 | Prototype Python | Python 3.10 via `uv`, project-local caches (`UV_CACHE_DIR`, `HF_HOME` under the repo) so runs touch nothing outside the checkout. |
| 18 | Lexical tokenization (milestone-0 finding) | Text fields (title, path, context, body) are tokenized with stopwords removed and Porter-stemmed at index and query time; `citations` and `terms_defined` stay exact. With raw tokens, query function words such as `a`, `is`, `part` are rare in short boosted fields (a title reading "Subchapter A") and get a large IDF, so structural nodes outrank the section the question is about: locate Recall@5 was 0.87 raw and 0.95 with the change; body-only BM25 goes 0.87 to 0.97 (`eval/results/m0-ablation.md`). Carry into the tantivy tokenizer at milestone 4. Proposed as spec-changes #6. |
| 19 | Embedding text (milestone-0 finding) | Keep breadcrumb + context + body as the embedded text. With `potion-retrieval-32M` the vector leg scores 1.00 locate Recall@5 on every chunk-text variant; mean-centering does not help (0.95 to 0.97). No spec change. |
| 20 | Signal scale (milestone-0 finding) | Rerank signals apply to the RRF score normalized so that rank 1 in both lists equals 1.0. The title/path boost is +0.10 times the fraction of query content words matched, and the adaptive x2 lexical weight requires the matched defined term to cover at least half of the query's content words (or a query of at most 3 content words). A flat +0.10 for one generic word and x2 for any question that mentions "employer" cost 0.04 to 0.10 Recall@5. Proposed as spec-changes #7. |
| 15a | Fork-or-borrow (milestone 0.5) | **No vendoring.** Depend on `tantivy` and `model2vec-rs` as the spec already planned; reimplement the lexical schema, the brute-force cosine leg, and the rank signals. `zg` is reclassified from "forkable Rust hybrid" to "design reference" because it is TypeScript. Per-crate table below. |
| 34 | Lexical, semantic, fusion (milestone 4) | **Lexical:** tantivy 0.26 with the B.4 fields (`id`, `node` stored; `title` 3, `path` 2, `context` 1.5, `body` 1, `citations` 3, `terms_defined` 4; `source` and `kind` facets; `effective` date; `superseded` bool) plus `self_id` (own-id components, boost 6; spec-changes #12). Text fields are stop-worded and Porter-stemmed (decisions #18); `citations` and `self_id` use an id tokenizer (`CFR:99-2.8` -> `cfr:99-2.8`, `99-2.8`, `2.8`). Queries are built as boosted term clauses, so no query-syntax escaping issues; as-of, scope, and superseded filters are an allowed-Expression `TermSetQuery`, source and kind are facet terms. **Semantic:** `model2vec-rs` 0.2.1 (the spec's 0.3.0 does not exist; spec-changes #13) with `fancy-regex` instead of oniguruma, behind an `EmbeddingProvider` trait; `remote:` specs are refused until configured. `potion-retrieval-32M` is fetched into the Hugging Face cache at index time and copied into `.sect/semantic/model/`, so a query loads it from local files (about 230 ms per process in release, most of the query cost). `vectors.bin` is a normalized f32 matrix with ids; brute-force dot product; exact search is the intended path below ~1M rows. **Fusion:** the `rrf` crate (`fuse_weighted`, k=60), scores normalized so rank 1 in both lists is 1.0; collapse per Work, per Expression under `--include-superseded` (spec-changes #14). A `.sect/.lock` file serializes concurrent builds after two test processes raced on the tantivy directory. **Chunks:** one per section file, split above 2,000 tokens at top-level labels only; text = breadcrumb + context + body + flattened table rows. **C1 (eCFR XML path, early):** `packages/sect-convert` in TypeScript on `@xmldom/xmldom`; Titles 1 and 4 (510 sections, 638 nodes) convert into the B.2 contract with zero validation errors; the context prefix is a deterministic placeholder for WS3 to replace. **Prose xrefs:** bare citations resolve against the home title only (spec-changes #11), found when two titles shared the same `§ 2.1`. Term-usage counting was rewritten to one regex pass per document (validation of 638 files: 5.5 s to 1.2 s). **Numbers** (`eval/results/m4.md`): fixture fuse Recall@5 locate 0.95, definition 1.00, id-lookup 0.80 (fts alone 1.00: the vector leg hurts citation queries until the milestone-5 short-circuit), cross-ref 1.00 (all 18), table 1.00, overlay 0.83; real titles p50 234 ms, p95 240 ms for 50 queries. |
| 33 | `grep` choices (milestone 3) | Built on `grep-regex` (`RegexMatcherBuilder::build_many` with `-i`, `-w`, `-F`), `grep-searcher` (line numbers, before/after context, NUL binary detection like rg), `ignore` (hidden and gitignored entries skipped, `-g` globs through `OverrideBuilder` for gitignore semantics, siblings sorted by path exactly as `rg --sort path` does), and `globset` for glob validation. Never shells out. Every file is scanned even past `--max-hits` so the per-file counts are complete; beyond the bound the lines are dropped and the answer is `path:count` per file plus a `note:` line, which is byte-identical to `rg -c`. The two header lines and the `note:` line are the only additions over ripgrep's output; `--annotate` appends a tab and `[id#anchor label title]` per line, resolved from the tree and the nearest paragraph label above the line. `--scope` and `--source` restrict the files through the tree. Parity: 28 cases in `eval/golden/grep/cases.jsonl` compared with goldens recorded from ripgrep 14.1.1 and with a live `rg` when one is available (`RG=<path>` overrides PATH); all identical (`eval/results/m3.md`). |
| 32 | Structural layer choices (milestone 2) | Links and tables come from the comrak AST (GFM tables on). Prose citations come from each source's `id_pattern` applied to the body with link syntax blanked out, plus a built-in `part N` pattern for base sources; a section's references to itself are dropped; an unresolved prose citation is a warning, an unresolved link is an error. Edge endpoints are Work ids except `supersedes` (an Expression id), `amends` (from an Action id), and `defines` (to `term:<slug>`). `refs` is breadth-first over `xrefs.jsonl` with depth clamped to 5; with `--as-of` it keeps only edges whose far endpoint and host Expression are active on that date, and a notice id expands to its Action ids. Term usages are counted at index time over current section-level Expressions with a word-boundary, plural-tolerant match, defining section excluded. `map --complete` returns the whole subtree in document order under a container, the top-level paragraphs under a section, and the nested paragraphs under `id#anchor`; no budget applies. Overlay markers are inserted into the body at read time as blockquote lines at the heading (`overridden-by`) and at the affected paragraph (`narrowed-by`). Fixture exact-match: refs 16/16, define 16/16, as-of 6/6, map --complete 8/8, history 2/2 (`eval/results/m2.md`). |
| 22 | Skeleton choices (milestone 1) | `serde_yaml_ng` 0.10 for front matter (`serde_yaml` is deprecated). The `ignore` walker skips hidden directories and gitignored files, so `.sect/` never indexes itself. Front-matter key presence is tracked separately from values, so `parent: null` (a root node) is distinguishable from a missing `parent`. The structural layer is rebuilt whole whenever any file changed (44 files in about 30 ms); milestone 6 makes that incremental. Queries read the section body from the markdown file at query time instead of duplicating it in `tree.json`. `sect index --validate-only` writes nothing and exits 1 on errors: that is the contract check WS3 runs on staging. Timings: `eval/results/m1.md`. |
| 21 | Milestone-0 gate | **Passed** on 2026-09-03: locate Recall@5 0.95, definition 1.00 (threshold 0.85). Rust may begin. The CRAwLeR filter at rank 3 kept 2 of 18 cross-ref questions on the 44-chunk fixture; results are reported for both the kept and the full set. Wrong-corpus abstention is 0.60 on the fixture (two near-topic controls share vocabulary with Part 3 and Part 2); no-gold abstention is 1.00. |
