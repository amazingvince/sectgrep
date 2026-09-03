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
| 16 | Prototype library | `semble` 0.5.5 (MinishLab, MIT) as the spec names it. It is a code-search library on `model2vec` + `vicinity`; the prototype uses its model2vec embedding path for the vector leg and adds `bm25s` for the lexical leg and its own RRF. See `proto/README.md` for what is borrowed and what is local. |
| 17 | Prototype Python | Python 3.10 via `uv`, project-local caches (`UV_CACHE_DIR`, `HF_HOME` under the repo) so runs touch nothing outside the checkout. |
