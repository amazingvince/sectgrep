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
| 14 | Name | `sectgrep` / `sect`, pending registry check; fallback `regsift`. | **Checked 2026-09-03, see 14a; final call pending human** |
| 15 | Retrieval core | Fork-or-borrow decision (0.5) against `zg` and `semble_rs` before writing. | Pending, milestone 0.5 |

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

**Decision: pending human.** `GOAL.md` section 7 lists the name fallback as a human call. Until it is made, the repository uses `sectgrep` / `sect`. Renaming before milestone 1 is a find-and-replace over `GOAL.md`, `README.md`, `proto/`, and `.github/`.

## Milestone 0 (2026-09-03)

| # | Question | Decision |
|---|---|---|
| 16 | Prototype library | `semble` 0.5.5 (MinishLab, MIT) as the spec names it. It is a code-search library on `model2vec` + `vicinity` with BM25 + vector RRF. The prototype uses its BM25 index (one per field), its model loading and chunk embedding, its tokenizer, and its plain hybrid search as a comparison arm; it adds the spec's chunk text, field weights, signals, structural graph, and stemming + stopword removal locally. See `proto/README.md`. |
| 17 | Prototype Python | Python 3.10 via `uv`, project-local caches (`UV_CACHE_DIR`, `HF_HOME` under the repo) so runs touch nothing outside the checkout. |
| 18 | Lexical tokenization (milestone-0 finding) | Text fields (title, path, context, body) are tokenized with stopwords removed and Porter-stemmed at index and query time; `citations` and `terms_defined` stay exact. With raw tokens, query function words such as `a`, `is`, `part` are rare in short boosted fields (a title reading "Subchapter A") and get a large IDF, so structural nodes outrank the section the question is about: locate Recall@5 was 0.87 raw and 0.95 with the change; body-only BM25 goes 0.87 to 0.97 (`eval/results/m0-ablation.md`). Carry into the tantivy tokenizer at milestone 4. Proposed as spec-changes #6. |
| 19 | Embedding text (milestone-0 finding) | Keep breadcrumb + context + body as the embedded text. With `potion-retrieval-32M` the vector leg scores 1.00 locate Recall@5 on every chunk-text variant; mean-centering does not help (0.95 to 0.97). No spec change. |
| 20 | Signal scale (milestone-0 finding) | Rerank signals apply to the RRF score normalized so that rank 1 in both lists equals 1.0. The title/path boost is +0.10 times the fraction of query content words matched, and the adaptive x2 lexical weight requires the matched defined term to cover at least half of the query's content words (or a query of at most 3 content words). A flat +0.10 for one generic word and x2 for any question that mentions "employer" cost 0.04 to 0.10 Recall@5. Proposed as spec-changes #7. |
| 15a | Fork-or-borrow (milestone 0.5) | **No vendoring.** Depend on `tantivy` and `model2vec-rs` as the spec already planned; reimplement the lexical schema, the brute-force cosine leg, and the rank signals. `zg` is reclassified from "forkable Rust hybrid" to "design reference" because it is TypeScript. Per-crate table below. |
| 22 | Skeleton choices (milestone 1) | `serde_yaml_ng` 0.10 for front matter (`serde_yaml` is deprecated). The `ignore` walker skips hidden directories and gitignored files, so `.sect/` never indexes itself. Front-matter key presence is tracked separately from values, so `parent: null` (a root node) is distinguishable from a missing `parent`. The structural layer is rebuilt whole whenever any file changed (44 files in about 30 ms); milestone 6 makes that incremental. Queries read the section body from the markdown file at query time instead of duplicating it in `tree.json`. `sect index --validate-only` writes nothing and exits 1 on errors: that is the contract check WS3 runs on staging. Timings: `eval/results/m1.md`. |
| 21 | Milestone-0 gate | **Passed** on 2026-09-03: locate Recall@5 0.95, definition 1.00 (threshold 0.85). Rust may begin. The CRAwLeR filter at rank 3 kept 2 of 18 cross-ref questions on the 44-chunk fixture; results are reported for both the kept and the full set. Wrong-corpus abstention is 0.60 on the fixture (two near-topic controls share vocabulary with Part 3 and Part 2); no-gold abstention is 1.00. |
