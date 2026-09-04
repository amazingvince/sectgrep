# Goal: Implement `sectgrep` (Engineering Spec v0.4)

**Source of truth:** `sectgrep-spec-v0.4.md` in this directory. Where this goal and the spec disagree, the spec wins. Where the spec is silent, decide, record the decision in `docs/decisions.md`, and continue.
**Status:** Bootstrap, milestone 0 (gate passed: locate 0.95, definition 1.00), milestone 0.5 (no vendoring; `zg` turned out to be TypeScript, see `docs/decisions.md` 15a), and milestone 1 (13-crate workspace; `index`, `read`, `map`, `status`; `eval/results/m1.md`) complete as of 2026-09-03, and milestone 2 (structure: xrefs, Actions, terms, tables, as-of snapping, `refs`, `define`, `map --complete`, `read --history`; exact-match 1.00 on the fixture, `eval/results/m2.md`) and milestone 3 (`grep` on the ripgrep crates; 28 parity cases identical to ripgrep 14.1.1, `eval/results/m3.md`) and milestone 4 (tantivy + model2vec `search` with RRF; p95 240 ms on two converted eCFR titles, `eval/results/m4.md`; the eCFR XML half of C1 shipped as `packages/sect-convert`) and milestone 5 (signal table, citation and definition short-circuits, `--expand`, `--seed`, abstention; all seven E.1 gates pass, `eval/results/m5.md`) and milestone 6 (incremental rebuilds across every layer, the pre-query stat pass, synchronous or background refresh, `--freshness auto|wait|no`; B.6 targets met on Linux and the NTFS gap documented, `eval/results/m6.md`) and milestone 7 (`sect-mcp` on rmcp over stdio and loopback HTTP, tool schemas from the CLI's own definitions, `sect install`, `docs/SKILL.md`, Pi and Claude Agent SDK examples with tests; release R1 as tag v0.1.0, nothing published) and milestone 3b (the sparse n-gram prefilter for grep, kept: outputs identical to brute force on every case, median speedup 199x in-process and 6.3x wall on the three-title corpus, `eval/results/m3b.md`) and milestone C0 (the OCR bake-off on 30 documents with local vLLM inference: PaddleOCR-VL-1.5 pipeline primary, olmOCR-2 pipeline secondary, Marker over Docling as orchestrator, a transcriber API boundary with a repetition guard and a per-model page-scaling policy in the converter, `eval/results/c0.md`) and milestone C1 (the Federal Register parser with Action candidates, born-digital PDF/DOCX/HTML/XLSX elements with the C.4 passes, the dual-transcriber scan path on the API pair olmOCR-2 + GLM-OCR; full Title 29 plus six notices validate with 0 errors, `eval/results/c1.md`) and milestone C2 (the seven C.5 validators as a library and `sect-convert validate`, each with passing and failing tests, run by CI on the fixture, which now ships its raw sources; `sect-convert align` on versioner point-in-time XML; release R2 as tag v0.2.0, `eval/results/c2.md`) and milestone H1 (the ingest harness on Pi: the seven verbs and six harness tools as Pi tools, the staging guard with its test, `docs/SKILL-ingest.md`, idempotent and serialized runs, a container, and a live run over Title 4 with its validator pass rate and cost in `eval/results/h1.md`) and milestone H2 (evidence checks, the answer-blind verifier on DeepSeek, consensus with the conflict queue in `review/`, Z1.4 sampling with grading, the merge script and rollback, the first auto-merge of Title 4 into `corpus/`, release R3 as tag v0.3.0, `eval/results/h2.md`) the next day. Open questions resolved with the human (`docs/decisions.md` #14, #23 to #31): name stays `sectgrep` / `sect`, GPUs under WSL2, public repo at `github.com/amazingvince/sectgrep`.
**Written:** 2026-09-03

---

## 1. Objective

Build the three workstreams in the spec into one working, Apache-2.0 open-source system that turns a hierarchical rules corpus (reference: eCFR bulk XML + Federal Register rules) into a structured markdown corpus that AI agents can search, navigate, cite, and reason over through the `sect` tool. Ingest is done by agents that propose to staging; validators and a blind second agent commit; humans see only conflicts and samples.

| WS | Name | Language | One-line scope | Spec |
|---|---|---|---|---|
| WS1 | `sect` | Rust | Single binary, no daemon, seven verbs (`search grep read refs define map status`) over CLI, MCP (`sect_*`), and library. Exact + n-gram, lexical (tantivy), semantic (model2vec), structural (graph) indexes. | Part B |
| WS2 | `sect-convert` | TypeScript (+ Docling/OCR subprocesses) | Raw docs to page elements; eCFR/FR native parsers; dual-transcriber OCR; the seven validators; version alignment. Models transcribe only, never judge. | Part C |
| WS3 | Ingest harness | TypeScript on Pi (`pi-agent-core`) | Ingest, Verifier, Notes, Lint agents. Propose, validate, blind-verify, commit. MCP surface keeps the Claude Agent SDK a drop-in target. | Part D |

Data flow: WS2 elements feed WS3, which writes sections using WS1 as its eyes; WS1 indexes the result; answering agents use WS1.

## 2. Definition of done

All of the following must hold:

1. **Four releases shipped** (tag + README + eval numbers each): R1 `sect` after milestone 7 with the eCFR converter and fixture; R2 `sect-convert` after C2; R3 harness after H2; R4 notes + lint after H4.
2. **Real ingest completed:** three CFR titles plus one amendment set (Federal Register rules) ingested end-to-end through the harness into `corpus/`, with git history as the audit trail and zero direct agent writes to `corpus/`.
3. **Eval gates met** (Part E):
   - E.1 retrieval: Recall@5 >= 0.90 (locate, definition); exact-match >= 0.95 (id-lookup, `refs`, `--as-of`, `map --complete`); abstention accuracy >= 0.90 on no-gold.
   - E.2 conversion: section-boundary >= 0.95 born-digital; table cell >= 0.98; xref precision >= 0.95 at auto-merge threshold; Action-extraction precision >= 0.95.
   - E.3 end-to-end: >= 30% fewer tool calls than a Read/Grep-only agent, no correctness regression, flat tool-call count across 1, 3, and 10 titles, N >= 3 runs per arm.
4. **Performance targets** (B.6): full index of one CFR title (~5-10k sections) < 60 s; single-file incremental < 500 ms; freshness stat < 10 ms for 10k files.
5. **Ingest quality reporting** (E.4) is produced per run: auto-merge rate, consensus agreement by field, conflict queue size, sampled error rate, time-to-merge, lint counts.
6. **Decisions recorded:** all 15 entries of F.3 plus every new decision, in `docs/decisions.md`.

## 3. Non-negotiable constraints

Carry these into every milestone. They come from A.3, A.4, A.5, and B.1.

- **Agents never write to `corpus/`.** Ingest writes to `staging/<run_id>/` only; `beforeToolCall` enforces it; ingest runs in a container. Merge is staging to corpus, `sect index`, git commit, by script.
- **Deterministic where the document has structure; LLM only where it does not; every LLM output checked against source text before commit.** Section bodies are copied from element/XML text, never paraphrased (validator 2 enforces at >= 0.92 token-level round-trip).
- **Structural guarantees come from graph traversal, never ranking.** Ancestor closure, descendant completeness (`map --complete`), and cross-reference expansion (`--expand refs`, `refs --depth`) are deterministic.
- **Chunk unit is the section file.** Split only above ~2,000 tokens and only at paragraph labels ((a), (b), (1), (i)...). Never mid-provision.
- **Versioning is Work / Expression / Action.** `--as-of D` snaps to the nearest Expression on or before D; current-only by default; Actions are first-class nodes from notices.
- **Bounded output, counts before content.** Every response leads with a freshness line and a counts line. `search` <= 50; `grep` <= `--max-hits` (default 200) then per-file counts. Abstention is an explicit result with nearest scope.
- **One binary, no daemon, no runtime, no network at query time.** Index is plain files in `corpus/.sect/`, gitignored, regenerable, content-hash cached.
- **Provenance on every result** to a page or XML node in `raw/`, with `legal_status` (eCFR XML is `unofficial-xml`).
- **Every human correction becomes a schema example or a validator rule**, not just a fixed file.
- **Apache-2.0 from the first commit.** Only permissively licensed dependencies (versions verified in B.7; avoid `rank-fusion`, use `rrf`).
- **Notes never outrank corpus.** `kind: note` indexed at lowest precedence with a -0.2 penalty.

## 4. Environment (verified 2026-09-03 on this machine)

| Tool | Version | Note |
|---|---|---|
| cargo / rustc | 1.92.0 | WS1 |
| node / npm / pnpm | 22.17.0 / 10.9.2 / 10.27.0 | WS2, WS3; use pnpm workspaces |
| python / uv | 3.10.17 / 0.9.11 | Milestone 0 prototype only; let `uv` pin whatever Python `semble` needs. `python3` is not on PATH (Microsoft Store stub). |
| docker | 29.1.3 | Ingest container, Linux CI parity, OCR model hosting |
| git / gh | 2.33.0 / 2.83.2 | Audit trail; PRs |
| tesseract | not installed | Optional third OCR opinion (C.3); install in the OCR container, not on the host |

**Platform caveat.** This is Windows 11. The spec lists Windows as a v1 non-goal (A.5). Treat Linux as the reference platform: run tests and evals in WSL2 or Docker, and do not block a milestone on a Windows-only failure. Do not gratuitously break Windows either, since it is the dev box.

**GPUs.** Two NVIDIA GPUs are available under WSL2 on this machine: an RTX 5090 (32 GB) and an RTX 4090 (24 GB). The OCR bake-off (C0), VLM transcription, and embedding experiments run inside WSL2 in Docker with CUDA (decisions #24). No paid vision API arm unless the human asks for one; confirm pricing before any such run (H.6, H.11).

## 5. Phase plan

### Bootstrap (before milestone 0; not in the spec but required)

- [x] `git init`; add `LICENSE` (Apache-2.0), `README.md` stub, `.gitignore` (`target/`, `node_modules/`, `corpus/**/.sect/`, `work/`, `staging/`, `raw/` except fixtures).
- [x] **Name check.** Run `cargo search sectgrep`, `cargo search sect`, `npm view sectgrep`, `npm view sect`, and check PyPI and Homebrew for both. Record the result in `docs/decisions.md`. If either collides, fall back to `regsift`. **Do not publish to any registry** in this phase.
- [x] Repo layout:
  ```
  crates/            sect-core sect-corpus sect-struct sect-exact sect-ngram sect-lexical
                     sect-semantic sect-rank sect-index sect-query sect-format sect-cli sect-mcp
  packages/          sect-convert/   sect-harness/
  proto/             Python prototype for milestone 0 (not shipped, not published)
  eval/              question sets, runners, golden/, results/<milestone>.md
  fixtures/          small synthetic corpus for CI (B.2 contract)
  corpus/ raw/ staging/ work/ review/ lint/   (gitignored except fixtures)
  docs/              decisions.md  spec-changes.md  SKILL.md  SKILL-ingest.md
  ```
- [x] CI (GitHub Actions, Linux): `cargo metadata` until the first crate lands, then `cargo test --workspace`; `pnpm -r test` from C1; `sect-proto validate` and the milestone-0 eval on the fixture now, `sect index --validate-only` and the C.5 validators once they exist.

### Milestones (from F.1, in single-track order)

The spec's dependency graph: 0, then 0.5, then 1, then 2, then 3 and 4, then 5, 6, 7; 3b after 3 and 6; C0, then C1, then C2; H1 needs 2 and C1; H2 needs C2 and 7; H3 needs H2 and 6; H4 needs H2; 8 last. A single engineer or agent runs them in the order below; two engineers follow F.2 (Rust on WS1, TypeScript on WS2/WS3).

| Order | # | WS | Deliverable | Gate / exit criterion | Spec | Est. |
|---|---|---|---|---|---|---|
| 1 | 0 | Eval | Fixture corpus; question set via CRAwLeR recipe with adversarial filter; chunking/ranking prototype in Python with `semble` | **Recall@5 >= 0.85 on locate/definition before any Rust is written** | E.1, A.1 | 3-5 d |
| 2 | 0.5 | WS1 | Read `zg` (zvec-grep) and `semble_rs`; per-crate vendor / depend / reimplement decision for `sect-lexical`, `sect-semantic`, `sect-rank` | Decision table committed to `docs/decisions.md` | B.7, H.8 | 2 d |
| 3 | C0 | WS2 | Extractor + OCR bake-off: Docling vs Marker; PaddleOCR-VL-1.5 vs GLM-OCR vs MinerU2.5 vs olmOCR-2 vs one general vision API on 30 pages (10 eCFR born-digital, 10 scanned FR, 10 tables) | Primary + secondary transcriber chosen on TextEdit + reading order; pricing confirmed; recorded | C.3, H.6 | 3-4 d |
| 4 | 1 | WS1 | Workspace, core types, corpus walker, front matter, validation, `tree.json`, `read`, `map`, `status` | Fixture indexes; three verbs work on CLI with freshness + counts lines | B.2, B.3, B.6 | 1 wk |
| 5 | 2 | WS1 | Xrefs, Actions, terms, tables, precedence (`overridden_by`, `narrowed_by`), Work/Expression `--as-of` with snapping, `refs`, `define`, `map --complete`, `read --history` | Exact-match tests for `refs`, `define`, `--as-of`, `map --complete` pass on fixture | B.4 structural, versioning | 1.5 wk |
| 6 | C1 | WS2 | eCFR XML and FR XML native parsers (DIV1-8, NODE, CROSSREF, EFFDNOT, AUTH/SOURCE, amendatory instructions to Action candidates); PDF/DOCX/HTML/XLSX extraction; dual-transcriber OCR path with divergence flags | One real CFR title converts to the B.2 contract and passes `sect index --validate-only` | C.3, C.4 | 2 wk |
| 7 | 3 | WS1 | `grep` on `grep-*` crates, rg-compatible flags and `path:line:text` output, bounded hits + counts | rg output parity tests; `--max-hits` overflow returns counts | B.4 exact | 2-3 d |
| 8 | 4 | WS1 | tantivy schema (incl. `citations`, `context`, `terms_defined` fields, custom ID tokenizer); `model2vec-rs` + `potion-retrieval-32M`; brute-force cosine; `search` with RRF k=60 | Hybrid `search` runs on the real title from C1 | B.4 lexical, semantic | 1 wk |
| 9 | C2 | WS2 | Validators 1-7 as library + CLI; `sect-convert align` via the versioner API | Validators run in CI on fixture; `align` produces `changes.json` for two eCFR dates. **Release R2** when README is ready. | C.5, C.6 | 1 wk |
| 10 | 5 | WS1 | Rerank signals table, citation short-circuit, adaptive lexical weight, `--expand refs\|ancestors`, `--seed --budget`, abstention | **E.1 gates met** on the real-corpus question set | B.4 fusion, B.3 | 1 wk |
| 11 | 6 | WS1 | blake3 fingerprints, incremental index, background rebuild, `--freshness wait`, `--no-refresh` | B.6 timing targets measured and recorded | B.6 | 3-4 d |
| 12 | 7 | WS1 | `sect-mcp` on `rmcp` (stdio default, loopback HTTP), tool schemas, `--toolset full` for admin verbs, `sect install`, answering-agent `SKILL.md`, Pi and Claude Agent SDK examples | Both SDKs call all seven verbs unchanged. **Release R1.** | B.3 MCP | 3-4 d |
| 13 | H1 | WS3 | Pi harness; `sect` verbs + harness tools as `ToolDefinition`s; ingest loop steps 1-7, 10-11 in `SKILL-ingest.md`; staging; `submit()`; context-prefix generation; eCFR titles first | One CFR title ingested to staging and passes validators; Pi package scope + version pinned | D.1, D.2 | 1.5 wk |
| 14 | 3b | WS1 | Sparse n-gram prefilter: corpus-derived pair weights, literal extraction, mmap table + roaring postings, `--no-index`, auto threshold 200 MB | **>= 5x median speedup on a 3-title corpus for typical agent regexes, else cut the feature** | B.4 exact | 1 wk |
| 15 | H2 | WS3 | Evidence checks, answer-blind verifier on a different provider, consensus, acceptance sampling against a named standard (e.g. ANSI/ASQ Z1.4), `review/<run_id>.md`, merge script, rollback | First auto-merge into `corpus/` via the script; verifier measured against golden labels. **Release R3.** | D.3 | 1.5 wk |
| 16 | H3 | WS3 | Ingest steps 8-9: overlays (`overrides`/`narrows`) and notices (Action pipeline) end-to-end on real FR rules and one overlay set | One amendment set and one overlay merged with consensus | D.2, C.3 | 1.5 wk |
| 17 | H4 | WS3 | Notes agent, lint agent, notes penalty, E.3 with notes on/off | Lint report produced nightly; notes indexed at lowest precedence. **Release R4.** | D.4, D.5 | 1 wk |
| 18 | 8 | Eval | E.2 conversion golden set (30-50 pages), E.3 BrowseComp-Plus protocol with four arms plus corpus-size scaling arm; results in README | **E.2 and E.3 gates met**; three titles + one amendment set ingested | E.2, E.3 | 1 wk |

Total: roughly 16-18 engineer-weeks; about 8-9 calendar weeks with two engineers.

## 6. Decisions

**Already made, do not reopen** (F.3, 15 entries): scanned material in scope; spreadsheet and PDF overlays; `overrides` + `narrows` both v1; `potion-retrieval-32M` via `model2vec-rs`, no distillation, contextual prefixing not late chunking; answer-blind verifier on a different provider; sparse n-grams gated on speedup; single root; eCFR + FR as reference corpus with `unofficial-xml` status; Pi primary with Claude Agent SDK via MCP; Apache-2.0; Rust for `sect`, TypeScript elsewhere; section-file chunking; Work/Expression/Action with snapping; name `sectgrep`/`sect` pending check; fork-or-borrow before writing retrieval crates.

**To make and record during this goal:**

| Decision | When | Where recorded |
|---|---|---|
| Final name after registry check (`sectgrep`/`sect` or `regsift`) | Bootstrap | `docs/decisions.md` #14 |
| Vendor / depend / reimplement per retrieval crate | 0.5 | `docs/decisions.md` #15 |
| Primary + secondary OCR transcriber; general vision API and its confirmed price | C0 | `docs/decisions.md` (new) |
| Docling vs Marker as layout orchestrator | C0 | `docs/decisions.md` (new) |
| Pi package scope (`@mariozechner/*` vs `@earendil-works/*`) and exact pin | H1 | `docs/decisions.md` (new) + lockfile |
| Claude Agent SDK tool-registration specifics | 7 | `docs/decisions.md` (new) |
| Acceptance-sampling standard and sample sizes | H2 | `docs/decisions.md` (new) |
| Keep or cut the n-gram index | 3b | `docs/decisions.md` #6 |

## 7. Working agreements

- **One milestone, one branch, one PR.** Merge only when the milestone's gate passes and CI is green.
- **Every milestone ends with:** tests green; numbers written to `eval/results/<milestone>.md`; decisions logged; a short progress note (what shipped, what the gate measured, what is next).
- **Deviations from the spec are proposals, not silent changes.** Write them to `docs/spec-changes.md` as candidate v0.5 edits with the evidence that motivated them.
- **Fixture in the repo, real corpora by script.** `fixtures/` is committed. Real eCFR titles and FR rules are fetched by acquisition scripts into `raw/<source>/<version>/` (gitignored) from GPO bulk data and `ecfr.gov/api/versioner/v1/full/{date}/title-{n}.xml`; snap dates to allow the 1-2 business-day lag.
- **Bounded retries.** Ingest fixes hard validator failures at most 3 times per run (D.2 step 10), then submits with flags.
- **Stop and ask a human before:** spending money (paid vision APIs, hosted model inference, new provider accounts); publishing to crates.io, npm, PyPI, or Homebrew; choosing the name fallback; anything needing credentials or API keys; resolving a D.3 **conflict** tier item (those are the human queue by design); changing a licensed dependency to a non-permissive one.
- **Do not build:** applying rules to a specific case; multi-tenant or remote servers; auth beyond loopback; federation across corpus roots; exhaustive human review; late chunking; Windows-specific support (A.5).

## 8. Next actions

1. G-N2, the pre-H3 groundwork (below): the ingest cost (28 dollars per million document tokens in H1) comes down by linking explicit citations in code before any model turn and trimming what the agent sees; the versioner's per-section effective dates go into the eCFR converter so notices and sections share a timeline; and a `resolve` command carries a human's decision from the review file back into staging and the merge. Then H3 (overlays and notices end to end on real Federal Register rules and one overlay set, with consensus), H4 and milestone 8. The scanned-page second reader is now the hosted GLM 5.3 flash (decision #44); the verifier is the dated `deepseek/deepseek-v4-flash-0731` (decision #43). Locally the transcriber pair is served by `packages/sect-convert/bakeoff/scripts/serve-pair.sh`.
2. No human decision is pending before H3. The conflict queue in `review/` and the sample to grade are the human's standing work; a graded error becomes a schema example or validator rule. The OpenRouter key must be in `.env` (copy `.env.example`) before a run; the one shown in the session is to be rotated. Stop-and-ask points stay a new paid provider or account (OpenRouter with the chosen model is authorized) and publishing.

Done: bootstrap, milestones 0, 0.5, 1, 2, 3, 3b (kept), 4, 5, 6, 7 (release R1, tag v0.1.0), C0 (OCR bake-off), C1 (native parsers, elements, dual-transcriber OCR), C2 (validators and align, release R2 as tag v0.2.0), H1 (ingest harness v1) (all 2026-09-03) and H2 (verification, consensus, sampling, merge; release R3 as tag v0.3.0; 2026-09-04).

## 9. Running this with `/goal`

Claude Code's `/goal` takes one plain-text completion condition (max 4,000 characters), starts a turn immediately, and after every turn a small fast model judges the condition met, not yet met, or impossible. Run it in auto mode so turns proceed unattended. `/goal` alone shows status; `/goal clear` stops it. An active goal is restored when the session is resumed (turn count resets). Docs: https://code.claude.com/docs/en/goal

Two properties of the evaluator shape how the conditions below are written:

- **It only reads the conversation.** It never runs commands or opens files. So every milestone must end by running the gate commands and printing the numbers, exit codes, and file listings in the transcript. A result that lives only in `eval/results/` is invisible to it.
- **It stops the loop if several turns pass with no tool use.** Keep working through tools; do not narrate.

One condition for an 8-week program cannot be judged turn by turn, so run **one goal per milestone**, in the order of section 5. Each condition below names the end state, the check that proves it, the constraints, and a turn cap. Paste one, let it finish, review the milestone's `eval/results/` note and PR, then paste the next. All of them assume this directory as the working directory and `GOAL.md` plus the spec as context.

### G-A: Bootstrap + milestone 0

```
/goal The repo is bootstrapped and milestone 0 of GOAL.md is complete: `git log` shows commits on main; LICENSE is Apache-2.0; the layout in GOAL.md section 5 exists (crates/, packages/, proto/, eval/, fixtures/, docs/) with a GitHub Actions workflow; docs/decisions.md records the cargo, npm, PyPI and Homebrew name-check result for sectgrep and sect; fixtures/corpus follows spec B.2 (front matter with id, source, parent, effective, provenance; _source.yaml per source; at least one overlay, one notice with an Action, and one superseded Expression); eval/questions/ holds a question set covering every E.1 type (locate, id-lookup, definition, cross-ref, subtree-completeness, overlay, as-of, amendment-history, table, no-gold, wrong-corpus, negative) built with the CRAwLeR recipe and an adversarial filter; and a documented command in proto/README.md exits 0 and writes eval/results/m0.md showing Recall@5 >= 0.85 on locate and definition for the Python semble prototype. Constraints: no Rust code beyond an empty Cargo workspace; no publishing to any registry; no paid APIs or spending; sectgrep-spec-v0.4.md is not modified; nothing outside this directory is changed. Stop after 80 turns if not met.
```

### G-B: Milestones 0.5 + 1

```
/goal Milestones 0.5 and 1 of GOAL.md are complete: docs/decisions.md has a per-crate vendor/depend/reimplement table for sect-lexical, sect-semantic and sect-rank citing what was read in zg and semble_rs; the Cargo workspace contains all 13 crates listed in spec B.7 (stubs allowed for crates not yet needed); `cargo build --workspace` and `cargo test --workspace` exit 0; `sect index fixtures/corpus` builds corpus/.sect/ with manifest.json, fingerprints.json and tree.json; `sect read`, `sect map` and `sect status` work on the fixture and every response begins with a freshness line and a counts line; `sect index --validate-only` rejects a fixture file with a missing id or parent and exits non-zero; eval/results/m1.md records index and query timings. Constraints: no network at query time; index files are plain files under corpus/.sect/; no publishing; no paid APIs; spec not modified. Stop after 100 turns if not met.
```

### G-C: Milestone 2

```
/goal Milestone 2 of GOAL.md is complete: `sect index` on fixtures/corpus produces xrefs.jsonl (edge types references, overrides, narrows, supersedes, amends, defines), actions.jsonl, terms.json and tables.jsonl; `sect refs` (--direction, --type, --depth up to 5), `sect define` (--usages, --scope), `sect map --complete`, `sect read --history`, `sect read --ancestors`, `--children`, `--tables`, and `--as-of` (snapping to the nearest Expression on or before the date, current-only by default, --include-superseded to widen) all work; `sect read` shows overridden-by and narrowed-by from higher-precedence overlays inline at the affected heading; `cargo test --workspace` exits 0 and includes exact-match tests for refs, define, as-of and map --complete against the E.1 question set; eval/results/m2.md records exact-match = 1.0 on the fixture for those four verbs. Constraints: structural results come from graph traversal only, never ranking; no publishing; spec not modified. Stop after 100 turns if not met.
```

### G-D: Milestone C0 (OCR bake-off)

```
/goal Milestone C0 of GOAL.md is complete: raw/bakeoff/ holds 30 pages (10 eCFR born-digital, 10 scanned pre-1994 Federal Register, 10 with tables) with hand-checkable ground truth under eval/golden/bakeoff/; packages/sect-convert/bakeoff/ runs Docling and Marker for layout, and PaddleOCR-VL-1.5, MinerU2.5 and olmOCR-2 (GLM-OCR only if its license permits) as containerized transcribers, scoring TextEdit, reading-order edit distance and TEDS per page; eval/results/c0.md contains the score table and a primary + secondary transcriber recommendation chosen on TextEdit and reading order; docs/decisions.md records the Docling-vs-Marker and OCR choices and notes GPU or hosted inference used. Constraints: do not call any paid vision API; if a paid arm is required, leave it as a clearly marked TODO with the pricing question for a human; list the license of every model weight before downloading it and skip any that is not permissive; no publishing; spec not modified. Stop after 80 turns if not met.
```

### G-E: Milestone C1

```
/goal Milestone C1 of GOAL.md is complete: packages/sect-convert converts (a) one full eCFR title from GPO bulk XML into the spec B.2 corpus contract (DIV1-DIV8 to tree, NODE to node and id, CROSSREF to xref candidates, EFFDNOT to effective and superseded-text records, AUTH/SOURCE to authority/citation, HEAD to title) and (b) Federal Register rule XML into notice files with Action candidates (target id, anchor, kind, effective, text) parsed from amendatory instructions; born-digital PDF, DOCX, HTML and XLSX inputs produce elements.jsonl matching the C.3 element schema plus report.json and page images under work/<raw_sha256>/, cached by input hash; scanned pages go through the primary and secondary transcribers chosen in C0 with per-line fuzzy matching and ocr_divergent flags; the C.4 deterministic passes emit structure.json, xrefs_candidates.jsonl and terms_candidates.json; `pnpm -r test` exits 0; `sect index --validate-only` exits 0 on the converted eCFR title; eval/results/c1.md records section counts, unresolved-ref counts and conversion time. Constraints: models transcribe only, no judgment calls in WS2; no paid APIs; raw/ is gitignored and fetched by script; no publishing; spec not modified. Stop after 120 turns if not met.
```

### G-F: Milestone 3 (grep)

```
/goal Milestone 3 of GOAL.md is complete: `sect grep` is implemented on grep-regex, grep-searcher, grep-matcher, ignore and globset (never shelling out to rg), accepts the common ripgrep flags (-i, -w, -F, -e, -g, -n, -c, -l, -A, -B, -C), emits path:line:text by default and JSON with --json, supports --annotate, --count-only and --max-hits (default 200; beyond it returns per-file counts and asks the agent to narrow); every response begins with freshness and counts lines; tests compare `sect grep` output to ripgrep on the fixture for at least 20 patterns and pass; `cargo test --workspace` exits 0. Constraints: no publishing; spec not modified. Stop after 60 turns if not met.
```

### G-G: Milestone 4 (lexical + semantic)

```
/goal Milestone 4 of GOAL.md is complete: sect-lexical builds a tantivy 0.26 index with the spec B.4 fields (id, node stored, title boost 3, path boost 2, context boost 1.5, body, citations, terms_defined boost 4, source and kind facets, effective date, superseded bool) and a tokenizer that splits section IDs into components; sect-semantic embeds breadcrumb + context + body with model2vec-rs and potion-retrieval-32M behind an embedding-provider trait and searches by brute-force SIMD cosine over vectors.bin; `sect search` fuses BM25 top-100 and vector top-100 with RRF k=60 via the rrf crate, honors --fts, --vector, --fuse, --scope, --source, --kind, --as-of, --include-superseded, --limit (max 50) and --json, and collapses to one hit per section; `sect search` answers 50 queries on the converted eCFR title from C1 with p95 under 1 s; `cargo test --workspace` exits 0; eval/results/m4.md records Recall@5 and NDCG@10 per E.1 type. Constraints: no network at query time and remote embedding providers are opt-in only; no publishing; spec not modified. Stop after 100 turns if not met.
```

### G-H: Milestone C2 (validators + align)

```
/goal Milestone C2 of GOAL.md is complete: packages/sect-convert exposes the seven spec C.5 validators as a library and a `sect-convert validate <staging>` CLI (validate-only index; round-trip text >= 0.92 token-level with the context block excluded and required to score < 0.8 against the body; table cell check; xref precision including active-at-effective-date; provenance completeness; precedence sanity; Action integrity); each validator has a passing and a failing fixture test; `sect-convert align <source> <old> <new>` matches by node/id, then title, then text and writes changes.json, demonstrated on two eCFR point-in-time dates fetched from the versioner API; `pnpm -r test` exits 0; CI runs the validators on fixtures/corpus; README.md documents sect-convert and a git tag v0.2.0 exists (release R2). Constraints: no paid APIs; no publishing to registries; spec not modified. Stop after 80 turns if not met.
```

### G-I: Milestone 5 (rank + seed, E.1 gates)

```
/goal Milestone 5 of GOAL.md is complete and the E.1 gates pass: `sect search` implements the spec B.4 signal table (citation short-circuit via id_pattern, adaptive lexical weight x2 for ID/term-like queries, definition resolution, title/path +0.10, section coherence +0.10, hub boost log(1+refs_in) x 0.02 capped at 0.10, superseded filtered or -0.5, notes -0.2), --expand refs and --expand ancestors, --seed --budget N as a lexical-heavy RRF context block under a token budget, and explicit abstention with nearest scope when nothing clears the confidence floor; eval/results/m5.md, produced by the eval runner over the real-corpus question set from milestone 0, shows Recall@5 >= 0.90 on locate and definition, exact-match >= 0.95 on id-lookup, refs, as-of and map --complete, abstention accuracy >= 0.90 on no-gold, and latency p50/p95 per verb; `cargo test --workspace` exits 0. Constraints: ranking never provides structural guarantees; no publishing; spec not modified. Stop after 120 turns if not met.
```

### G-J: Milestone 6 (freshness)

```
/goal Milestone 6 of GOAL.md is complete: `sect index` uses blake3 fingerprints to diff the corpus walk and rebuilds only changed files across the structural, tantivy, embedding and n-gram layers, writing manifest.json and log.jsonl; every verb stats the tree before answering and reports fresh, or runs a synchronous incremental for small change sets, or answers possibly_stale (N changed) and rebuilds in the background for large ones; --freshness wait and --no-refresh work; `sect index --full` on one converted CFR title completes in under 60 s, a single-file change re-indexes in under 500 ms, and the freshness stat on 10k files takes under 10 ms, all measured and recorded in eval/results/m6.md; `cargo test --workspace` exits 0. Constraints: re-running on unchanged input performs no work; no publishing; spec not modified. Stop after 60 turns if not met.
```

### G-K: Milestone 7 (MCP + install, release R1)

```
/goal Milestone 7 of GOAL.md is complete and release R1 is cut: sect-mcp serves sect_search, sect_grep, sect_read, sect_refs, sect_define, sect_map and sect_status over stdio by default and over `sect serve --http 127.0.0.1:7999` (loopback only), with index and rebuild exposed only under --toolset full; tool schemas are generated from the same definitions the CLI uses; `sect install` places the binary and registers the MCP server; docs/SKILL.md tells an answering agent how to use the seven verbs; examples/pi and examples/claude-agent-sdk each call all seven verbs unchanged and are exercised by a test; docs/decisions.md records the Claude Agent SDK tool-registration specifics; README.md documents install, the eCFR converter, the fixture, and the E.1 numbers from milestone 5; a git tag v0.1.0 exists on main; `cargo test --workspace` and `pnpm -r test` exit 0. Constraints: do not publish to crates.io, npm, Homebrew or any registry (tag only); no auth beyond loopback; spec not modified. Stop after 80 turns if not met.
```

### G-L: Milestone H1 (ingest agent v1)

```
/goal Milestone H1 of GOAL.md is complete: packages/sect-harness runs an Ingest agent on pi-agent-core with the canonical Pi package scope and exact versions pinned in the lockfile and recorded in docs/decisions.md; the seven sect verbs and the harness tools (staging_write, staging_validate, submit) are registered as Pi ToolDefinitions; a beforeToolCall hook rejects any write outside staging/<run_id>/ and a test proves it; ingest loop steps 1-7 and 10-11 of spec D.2 are encoded in docs/SKILL-ingest.md, including the context-prefix rule (50-100 tokens, names at least one referenced section's subject, no paraphrase of the body); a run over one converted eCFR title produces staging/<run_id>/ that passes all C.5 validators and a submit summary listing sections added, xrefs resolved with a low-confidence list, and flags; runs are idempotent per raw hash and serialized per source; the harness runs inside a container defined in packages/sect-harness/Dockerfile; `pnpm -r test` exits 0; eval/results/h1.md records validator pass rate and cost per document token. Constraints: no direct writes to corpus/; use only the model provider already configured in the environment and do not add paid accounts; no publishing; spec not modified. Stop after 120 turns if not met.
```

### G-M: Milestone 3b (n-gram index, keep or cut)

```
/goal Milestone 3b of GOAL.md is decided and complete: sect-ngram builds a sparse n-gram prefilter from corpus-derived character-pair weights (weights.bin), extracts required literals with regex_syntax::hir::literal::Extractor, stores candidates as roaring bitmap postings behind an mmap'd sorted hash-to-offset table (table.bin, postings.bin), verifies candidates with the real matcher, never excludes a true match (property test against brute force on the fixture and the real corpus), falls back to full scan when no literal is extractable, auto-enables above 200 MB and is disabled by --no-index; a benchmark over a 3-title corpus with at least 30 typical agent regexes is recorded in eval/results/m3b.md; docs/decisions.md entry 6 records keep (median speedup >= 5x) or cut (feature removed from the default path). Constraints: correctness before speed, a single missed true match fails the milestone; no publishing; spec not modified. Stop after 80 turns if not met.
```

### G-N: Milestone H2 (verification + commit, release R3)

```
/goal Milestone H2 of GOAL.md is complete and release R3 is cut: packages/sect-harness implements the spec D.3 evidence checks for overrides/narrows, supersedes/amended_by, prose xrefs and OCR-divergent spans; an answer-blind Verifier agent on a different provider than Ingest redoes every judgment field from the same inputs without access to Ingest's answers; consensus auto-merges agreeing fields with both runs in provenance and routes disagreements to review/<run_id>.md containing both proposals, rationales and the searches behind them; acceptance sampling draws N stratified items per source per run (default 20) under a named standard recorded in docs/decisions.md, with a grading template and a threshold rule (relax below 2%, tighten above); a merge script moves staging to corpus/, runs sect index and commits, and rollback is a documented git revert; verifier agreement with golden labels is measured and recorded in eval/results/h2.md; one real eCFR title is auto-merged into corpus/ through this path; README documents the harness; git tag v0.3.0 exists; `pnpm -r test` exits 0. Constraints: conflict-tier items stay in the human queue and are never auto-resolved; no direct agent writes to corpus/; no publishing to registries; spec not modified. Stop after 120 turns if not met.
```

### G-N2: Pre-H3 groundwork (ingest cost, section dates, resolve)

```
/goal The pre-H3 groundwork G-N2 of GOAL.md is complete: (1) the ingest harness links explicit citations in code before any model call, so a `§ N.M`, `N CFR N.M`, `part N` or `paragraph (x) of this section` reference with exactly one real candidate costs no model turn and is recorded as deterministic in provenance; search results returned to the agent are trimmed to the matching lines with one line of context each; the system prompt and tool schemas are compact; and the effect is measured by re-running Title 4 through the harness at no more than 12 dollars per million document tokens with a validator pass rate no lower than H1's 1.000, appended to eval/results/h1.md. (2) The eCFR converter takes each section's effective date from the versioner API (cached under raw/cfr-title-N/) instead of the title date, with a test that a section's date never exceeds the title's up-to-date-as-of date, and Title 4 is re-converted to show the spread of dates. (3) `sect-harness resolve --run <run_id> --id <section id> --pick ingest|verifier|none|<id>` applies a human's decision from review/<run_id>.md to staging, re-runs the evidence checks and consensus for that section, re-merges it and any section it unblocked through the merge script, appends the decision as an example to docs/SKILL-ingest.md, and is covered by a test. (4) `pnpm -r test` exits 0 and CI is green on main. Constraints: only the configured OpenRouter models; no direct writes to corpus/ outside the merge script; no publishing; spec not modified. Stop after 80 turns if not met.
```

### G-O: Milestone H3 (overlays + notices)

```
/goal Milestone H3 of GOAL.md is complete: ingest steps 8 and 9 of spec D.2 are implemented and encoded in docs/SKILL-ingest.md; for overlays the agent searches the base corpus and proposes overrides/narrows with rationale as judgment fields that go through consensus; for notices the agent takes WS2 Action candidates plus sect_read of the current Expression and writes a new Expression with supersedes and amended_by, also through consensus; one real Federal Register amendment set and one overlay set (spreadsheet or PDF) are ingested end-to-end into corpus/ with Actions in actions.jsonl, `sect read --history` showing Expressions and Actions, `sect refs --type amends` walking notice to section, and `sect read` showing overridden-by and narrowed-by; eval/results/h3.md records Action-extraction precision and amendment-mapping precision against human labels; `pnpm -r test` exits 0. Constraints: judgment fields never auto-merge without consensus; no direct agent writes to corpus/; no publishing; spec not modified. Stop after 120 turns if not met.
```

### G-P: Milestone H4 (notes + lint, release R4)

```
/goal Milestone H4 of GOAL.md is complete and release R4 is cut: a Notes agent runs after each merge and writes kind: note pages under corpus/notes/ (cross-source comparisons, notice digests, hub pages) with sources: [{id, hash}], typed wikilinks and a section-ID citation on every claim, indexed at lowest precedence with the -0.2 penalty; a Lint agent runs nightly and after large merges, emitting lint/<date>.md covering sect status plus orphans, unresolved refs, undefined terms, overlays whose base was superseded, notes with drifted source hashes, conflicting overlays from one source, single-run judgment fields and Actions with missing target Expressions, and never edits; eval/results/h4.md compares the E.3 agent loop with notes on and off; README documents notes and lint; git tag v0.4.0 exists; `pnpm -r test` exits 0. Constraints: notes never outrank corpus in any search result, proven by a test; no publishing; spec not modified. Stop after 80 turns if not met.
```

### G-Q: Milestone 8 (end-to-end + scaling eval, definition of done)

```
/goal Milestone 8 of GOAL.md is complete and every item in GOAL.md section 2 holds: eval/golden/ contains a 30-50 page hand-corrected conversion golden set spanning born-digital eCFR, scanned Federal Register, tables/matrices, overlay and notice; eval/results/m8-conversion.md shows section-boundary accuracy >= 0.95 born-digital, table cell >= 0.98, xref precision >= 0.95 at the auto-merge threshold, and Action precision >= 0.95; eval/results/m8-e2e.md follows the BrowseComp-Plus protocol with a fixed corpus, agent and prompt, N >= 3 runs per arm, arms cold (Read/Grep only), sect, sect + seed, sect + notes, plus a corpus-size arm at 1, 3 and 10 titles, reporting accuracy, evidence recall, average tool calls, tokens, wall time and cost, and shows >= 30% fewer tool calls than cold, no correctness regression, and flat tool calls across sizes; three CFR titles plus one amendment set are ingested into corpus/ through the harness with git history as audit trail; E.4 ingest-quality metrics are reported; README.md carries all result tables. Constraints: only the provider already configured in the environment; no publishing to registries; spec not modified. Stop after 150 turns if not met.
```

### Umbrella (only if you want a single long-running goal)

```
/goal Every item in section 2 (Definition of done) of GOAL.md in this directory is satisfied, worked through in the order of GOAL.md section 5, with each milestone's gate recorded in eval/results/ and each decision in docs/decisions.md. Constraints: follow sectgrep-spec-v0.4.md as the source of truth and do not modify it; never write to corpus/ from an agent; never publish to any registry; never spend money or add paid providers; stop and report at every "stop and ask a human" item in GOAL.md section 7. Stop after 600 turns if not met.
```
