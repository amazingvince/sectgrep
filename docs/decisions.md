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
| 21 | Milestone-0 gate | **Passed** on 2026-09-03: locate Recall@5 0.95, definition 1.00 (threshold 0.85). Rust may begin. The CRAwLeR filter at rank 3 kept 2 of 18 cross-ref questions on the 44-chunk fixture; results are reported for both the kept and the full set. Wrong-corpus abstention is 0.60 on the fixture (two near-topic controls share vocabulary with Part 3 and Part 2); no-gold abstention is 1.00. |
