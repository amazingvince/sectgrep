# sectgrep — Engineering Spec v0.4

**Status:** Draft for engineering review
**Date:** 2026-09-03
**Supersedes:** v0.3 (`gsearch-spec.md`). This version folds in the 2026-09-02 research survey (Part H) and replaces the `gs` placeholder.
**License:** Apache-2.0. Open source from the first commit.
**Name:** project `sectgrep`, binary `sect`, MCP tool prefix `sect_`, index dir `.sect/`. Chosen from the survey's clean-scan list (`sectgrep`, `corpusgrep`, `statgrep`, `regsift`); `gs` collided with Ghostscript, `hgrep`/`ordinal`/`canon` are taken. **Run authoritative `cargo search`, `npm view`, PyPI and Homebrew checks for both `sectgrep` and `sect` before the first publish; fall back to `regsift` if either collides.**

---

## Part A — Program overview

### A.1 What we are building

A system that turns a diverse, changing corpus of rules and guidelines into something an AI agent can navigate, cite, and reason over reliably. Target corpora share a shape: a large hierarchical base standard, local or organizational amendments that override parts of it, periodic update notices, and heavy cross-referencing. Reference corpus: the US Code of Federal Regulations (eCFR bulk XML, ecfr.gov versioner API, Federal Register). Other targets: building and fire codes with municipal amendments; tax regulations with rulings; clinical guidelines with hospital protocols; ISO/NIST standards with company policies; aviation or maritime regulations with operator manuals; platform developer policies with regional addenda; university regulations with departmental rules.

Three workstreams:

| Workstream | Name | Language | What it is |
|---|---|---|---|
| WS1 | `sect` | Rust | Single-binary search + navigation tool over a structured markdown corpus. Exact, lexical, semantic, and structural retrieval behind seven verbs, over CLI and MCP. Used by every agent in the system. |
| WS2 | `sect-convert` | TypeScript, with Docling/OCR models as subprocesses | Deterministic preprocessing of raw documents (born-digital and scanned PDF, DOCX, XLSX, HTML) into page elements, dual-transcriber OCR, and the validators. Models are used only for transcription, never for judgment. |
| WS3 | Ingest harness | TypeScript on Pi (`pi-agent-core`); MCP surface makes the Claude Agent SDK a drop-in second target | Agents that take preprocessed documents, use `sect` to find where they fit, write structured sections to staging, and maintain a synthesized notes layer. Propose → validate → blind-verify → commit. |

The relationship: WS2 produces elements → WS3 turns them into corpus sections using WS1 as its eyes → WS1 indexes the result → answering agents use WS1. WS1 is on the critical path, but its ranking is validated in a throwaway Python prototype (semble as the library) before any Rust is written (milestone 0) — the only Python in the program, and it is not shipped.

### A.2 What the research settled (summary; detail in Part H)

1. Chunk at the statutory section/subsection boundary and never cross it. Every alternative measured worse on legal text.
2. Cross-references and subtree completeness must be resolved by deterministic graph traversal; vector similarity cannot guarantee them. `refs` and `map` are load-bearing.
3. Versioning follows a Work / Expression / Action model: a section is a Work, each effective-dated text is an Expression, each amendment is a first-class Action node. `--as-of` resolves against Expressions.
4. Index-time contextual prefixes (Anthropic-style) are the pragmatic win for a static corpus; the contextualizing model matters more than the embedder, which is why a static embedding model is acceptable.
5. Grep is the right primitive for strong agents, but unbounded grep over a large corpus degrades sharply (tool calls double, accuracy drops as corpus grows). A sparse n-gram prefilter plus bounded, ranked output is the mitigation.
6. A better retriever both raises answer accuracy and reduces the agent's tool calls and cost. Investment in ranking pays twice.
7. Push a small, high-precision, lexical-heavy seed up front; pull everything else through verbs.
8. Small specialist OCR VLMs (0.9–1.2B) beat frontier general models on document parsing; use one as primary and an independent-architecture second for divergence checks.
9. The eCFR ecosystem already provides stable IDs, cross-ref and effective-date elements, a point-in-time API, and a typed TypeScript SDK. Reuse them.
10. Forkable Rust hybrids exist (`zg`, `semble_rs`, `ck`, `frankensearch`); evaluate borrowing before greenfielding the retrieval core.

### A.3 The four data layers and who writes them

| Layer | Contents | Written by | Trust |
|---|---|---|---|
| **Raw** | PDFs, XML, xlsx, notices as received. `raw/<source>/<version>/…` | Humans / acquisition scripts | Immutable ground truth |
| **Corpus** | Structured markdown sections with IDs, xrefs, precedence, effective dates (§B.2) | Ingest agent *proposes*; validators + blind consensus *commit*; humans resolve conflicts | Quotable as the rule |
| **Notes** | LLM-synthesized topic pages, comparisons, digests | Notes agent, freely | Helpful, lintable, never outranks corpus |
| **Schema** | `SKILL.md`, conventions, worked examples, validator rules | Humans + agents together | Governs behavior |

The non-negotiable: **the agent never has direct write access to the corpus layer.** It writes to staging; validators, evidence checks, and a blind second-agent consensus stand between staging and corpus. Git is the audit trail.

### A.4 Design principles

1. Deterministic where the document gives structure; LLM where it doesn't; every LLM output checked against source text before commit.
2. Structural guarantees (ancestor closure, descendant completeness, cross-reference expansion) come from graph traversal, never from ranking.
3. Indexes and intermediate artifacts are files on disk, cached by content hash. Re-running on unchanged input is free.
4. Small tool surface; bounded output; counts before content, so the agent narrows before it reads.
5. Every result carries provenance to a page or XML node in a raw document, and states the legal status of that source.
6. Every human correction becomes a schema example or a validator rule, not just a fixed file.

### A.5 Non-goals (v1)

- Applying rules to a specific case. The system finds and returns rules; the answering agent reasons.
- Multi-tenant server, remote indexes, auth beyond loopback. Windows.
- Multiple corpus roots (federation). One root; `source` is the scoping unit.
- Exhaustive human review of any layer. Verification is automated; humans resolve consensus conflicts and grade samples.
- Late chunking. Model2Vec is a static model, so contextual token embeddings do not apply; contextual *prefixing* is the substitute.

---

## Part B — WS1: `sect` (Rust search tool)

### B.1 Goals

- One binary, no daemon required, no runtime, no network at query time.
- Index is a directory of files the agent could also `Read`/`Grep` directly.
- Every query refreshes incrementally and reports freshness.
- Seven verbs, identical across CLI, MCP, and library.
- Output `path:line:text` compatible with ripgrep by default; JSON on request.
- Bounded output by default; every response leads with counts and freshness.

### B.2 Corpus contract (input to `sect`, output of WS3)

Directory tree of markdown, **one file per leaf section or subsection**, nesting mirrors document hierarchy. Path is informational; **front-matter `id` is canonical.**

```
corpus/
  cfr-title-29/                       # base standard
    _source.yaml
    I/A/1/1.1/29-1.1.md               # one file per section
  city-amendments/                    # overlay
    _source.yaml
    AM-12.md
  fr/2026/2026-12345.md               # notice (Federal Register rule) → Action nodes
  notes/                              # WS3 notes layer, kind: note
    _source.yaml
    egress-width-across-jurisdictions.md
```

Section file:

```markdown
---
id: CFR:29-1.1                            # Work id: canonical, stable across versions
node: "29:1.1.1.1.1"                      # source-native stable id (eCFR NODE attr) when one exists
source: cfr-title-29
title: Purpose and scope
parent: CFR:29-1
order: 1
effective: 2024-01-01                     # this Expression's effective date
supersedes: CFR:29-1.1@2021-01-01         # prior Expression, optional
superseded_by: null
amended_by: [FR:2023-27654#instr-3]       # Action(s) that produced this Expression
overrides: []                             # overlays only: base Work ids replaced
narrows: []                               # overlays only: [{id, anchor}] clause-level
defines: [employer]                       # terms defined here
authority: "29 U.S.C. 201 et seq."        # AUTH
citation: "55 FR 6737, Feb. 26, 1990"     # SOURCE
tags: []
context: >                                # WS3-written contextual prefix; indexed, never quoted as rule text
  Opening section of Part 1 (general provisions). Defines the scope of Part 1 and
  refers to § 1.2 for definitions and § 1.5 for exemptions.
provenance:
  raw: raw/cfr-title-29/2024-01-01/ECFR-title29.xml
  raw_sha256: "…"
  locator: {xpath: "//DIV8[@NODE='29:1.1.1.1.1']"}   # or pages + bbox for PDFs
  legal_status: unofficial-xml            # GPO XML is not the official legal edition
  ingest_run: 2026-09-03T14:03Z/ab12
  confidence: 0.97
  verified_by: [ingest:ab12, verifier:cd34]
---

# § 1.1 Purpose and scope

(a) This part … except as provided in [§ 1.5](CFR:29-1.5) …

(b) …
```

Rules:
- **Chunk unit is the file.** A section file is split only when it exceeds ~2,000 tokens, and then only at the paragraph-label level ((a), (b), (1), (i)…), never mid-provision. Splits carry the full breadcrumb.
- Cross-refs are markdown links whose target is a Work id or `id#anchor`. Paragraph labels become anchors (`CFR:29-1.5#a-2`).
- Tables are GFM; multi-dimensional matrices also get `<file>.tables.json` with flattened rows.
- Versioning: new Expression = new file, same `id`, new `effective`, `supersedes` set, `amended_by` pointing at the Action(s). Old versions are kept.
- Notices (`kind: notice`) are parsed into **Action** records: `{action_id, notice, target_id, target_anchor?, kind: amend|add|remove|redesignate|stay, effective, text}`. Actions are nodes in the structural graph, not just edges.
- `_source.yaml`: `name`, `kind` (base | overlay | notice | internal | note), `publisher`, `precedence` (int; notes lowest), `id_prefix`, `id_pattern`, `legal_status` (official | unofficial-xml | derived).

### B.3 Tool surface

Seven verbs. Every response begins with a freshness line and a counts line.

| Verb | Purpose | Key params |
|---|---|---|
| `search` | Ranked hybrid retrieval, optionally as a token-budgeted seed | `query`, `--fts`, `--vector`, `--fuse`, `--scope`, `--source`, `--as-of`, `--include-superseded`, `--kind`, `--limit` (≤50), `--expand refs\|ancestors`, `--seed --budget N`, `--json` |
| `grep` | Exhaustive exact/regex, rg-compatible flags and output, prefiltered by the n-gram index | ripgrep flags; `--annotate`; `--count-only`; `--max-hits` (default 200, bumps to a counts summary) |
| `read` | Section with structural context | `id[#anchor]`, `--ancestors`, `--children`, `--tables`, `--as-of`, `--version`, `--history` (list Expressions and Actions) |
| `refs` | Cross-reference / amendment traversal — the blast-radius verb | `id`, `--direction in\|out\|both`, `--type references\|overrides\|narrows\|supersedes\|amends\|defines`, `--depth ≤5`, `--as-of` |
| `define` | Defined-term lookup by structural resolution | `term`, `--usages`, `--scope`, `--as-of` |
| `map` | Table of contents; `--complete` returns a full subtree by traversal | `--scope`, `--budget` (default 1500), `--depth`, `--complete` |
| `status` | Freshness, counts, unresolved refs, warnings, legal-status summary | `--json` |

Design notes carried from the survey:
- **Citation-shaped queries short-circuit.** If `query` matches a source's `id_pattern` (e.g. `29 CFR 1.5`, `§ 1.5(a)(2)`), `search` resolves by direct ID lookup and returns that section first, before any ranking.
- **`--expand refs`** appends one-line summaries of every section the hits reference (depth 1), so a cross-reference-dependent answer is complete in one call.
- **`--seed`** returns a lexical-heavy RRF top-k, formatted as a compact context block under a token budget, meant for one-time injection at session start.
- **Bounded by default.** `grep` returns at most `--max-hits` matches; beyond that it returns per-file counts and asks the agent to narrow. `search` never exceeds 50.
- **Abstention is a result.** When nothing exceeds the confidence floor, the response says so explicitly and includes the nearest scope, so the agent can say "not found as of DATE."

`search` text output per hit: rank, ID, title, breadcrumb, effective date, matched line range with context, `overridden-by` / `narrowed-by` if any, refs-in/out counts, and the `--expand` block if requested.

MCP: `sect_search`, `sect_grep`, `sect_read`, `sect_refs`, `sect_define`, `sect_map`, `sect_status`. Admin verbs (`index`, `rebuild`) only with `--toolset full`. stdio default; `sect serve --http 127.0.0.1:7999` loopback only.

### B.4 Index layers

**Exact.** `grep-regex` / `grep-searcher` / `grep-matcher` / `ignore` / `globset` (ripgrep 15.x internals; never shell out). **Sparse n-gram prefilter:** required literals extracted with `regex_syntax::hir::literal::Extractor`; n-grams selected by a deterministic pair-weight function whose weight table is built from character-pair frequencies in the indexed corpus (legal English, not source code); postings as `roaring` bitmaps; one mmap'd sorted hash→offset table plus a postings file; candidates verified by the real matcher. Never excludes a true match; with no extractable literals, full scan. Borrow structure from `dmitri-lerko/instantgrep` and `gmilano/fast-grep-rust`. Auto-enabled above a measured threshold (default 200 MB); `--no-index` forces brute force.

**Lexical.** `tantivy` 0.26. Fields: `id`, `node` (stored), `title` (boost 3), `path` breadcrumb (boost 2), `context` (the WS3 prefix, boost 1.5), `body`, `citations` (a separate field holding every citation/ID token found in the body — the Poly-Vector idea: identifiers are rigid designators and get their own index), `terms_defined` (boost 4), `source` facet, `kind` facet, `effective` date, `superseded` bool. Custom tokenizer splits section IDs into components.

**Semantic.** `model2vec-rs` 0.3 with `potion-retrieval-32M` (MIT weights). Embedded text = breadcrumb + context prefix + body. Brute-force SIMD cosine over an f32 matrix; `usearch`'s own guidance is that exact search is the intended path below ~1M vectors. HNSW (usearch or zvec) only if the corpus grows past that. Embedding provider trait; remote providers explicit opt-in.

**Structural.** Deterministic, no model. `tree.json`, `xrefs.jsonl` (edge types: `references`, `overrides`, `narrows`, `supersedes`, `amends`, `defines`), `actions.jsonl` (Action nodes from notices), `terms.json`, `tables.jsonl`. Built from front matter + `comrak` AST (full CommonMark + GFM, AST-based). Fallback regex xref extractor for prose refs; unresolved refs reported in `status`.

**Versioning and precedence.** Work / Expression / Action:
- Work = `id`. Expression = `id@effective`. Action = an amendment record from a notice.
- A section is *active* at date D iff its Expression has `effective ≤ D` and is not superseded before D.
- `--as-of D` **snaps to the nearest published Expression on or before D** and defaults to current-only (superseded Expressions excluded unless `--include-superseded`). This mirrors the eCFR versioner's behavior and avoids the "search returns every historical version" trap.
- `read --history` lists all Expressions with the Actions between them. `refs --type amends` walks notice → section.
- `overridden_by` (whole section) and `narrowed_by` (anchor-level, shown inline at the affected heading in `read`) from higher-precedence overlays. Both from v1. `sect` surfaces the relationship; the agent decides applicability.

**Chunking.** One chunk per section file; oversize files split at paragraph labels only. Chunk text = breadcrumb + `context` prefix + body. Table rows chunked as sentences and stored structurally.

**Fusion / rerank.** BM25 top-100 + vector top-100 → RRF (k=60, `rrf` crate) → signals:

| Signal | Rule | Default |
|---|---|---|
| Citation short-circuit | Query matches `id_pattern` → direct lookup, rank 1 | on |
| Adaptive lexical weight | ID/term-like query (regex or exact hit in `terms.json`, or hits in `citations` field) → BM25 ×2 | on |
| Definition resolution | For `define`-shaped queries, the structurally-resolved defining section outranks usages | on |
| Title/path match | Query tokens in title or breadcrumb | +0.10 |
| Section coherence | ≥3 chunks from one section → collapse, boost best | +0.10 |
| Hub boost | log(1+refs_in) × 0.02, cap 0.10 | on |
| Superseded | Filtered at `as-of` (or −0.5 if included) | on |
| Notes penalty | `kind: note` −0.2 so rule text outranks synthesis | on |

Collapse to one hit per section.

### B.5 On-disk layout

```
corpus/.sect/
  manifest.json  fingerprints.json  tree.json  xrefs.jsonl  actions.jsonl
  terms.json     tables.jsonl        chunks.jsonl vectors.bin
  tantivy/       ngram/{weights.bin,table.bin,postings.bin}   log.jsonl
```
Gitignored, regenerable. Everything except `tantivy/`, `vectors.bin`, `ngram/` is human-readable.

### B.6 Indexing and freshness

`sect index [--full] [--embedding <model>] [--ngram on|off|auto] [--validate-only]`. Walk → blake3 fingerprint diff → validate changed files (errors block, warnings to status) → parse → rebuild structural files → update tantivy → re-embed changed chunks → n-gram update → manifest + log. Targets: full build of one CFR title (~5–10k sections) < 60 s; single-file incremental < 500 ms.

Every query stats the tree (< 10 ms for 10k files). Unchanged → `fresh`. Small change set → synchronous incremental. Large → answer `possibly_stale (N changed)` and rebuild in background. `--freshness wait` blocks; `--no-refresh` reads as-is.

`sect index --validate-only` is the contract check WS3 runs on staging before submitting.

### B.7 Crate layout and dependencies

```
crates/  sect-core  sect-corpus  sect-struct  sect-exact  sect-ngram  sect-lexical
         sect-semantic  sect-rank  sect-index  sect-query  sect-format  sect-cli  sect-mcp
```

Verified 2026-09-02: `tantivy` 0.26.1 (MIT), `model2vec-rs` 0.3.0 (MIT), `rmcp` 3.x (MIT, MCP 2026-07-28), `roaring` 0.11.5, `grep-regex` 0.1.14 / `grep-searcher` 0.1.16 / `ignore` 0.4.29 / `globset` 0.4.18 (Unlicense OR MIT), `regex-syntax` 0.8.11, `comrak` 0.54 (BSD-2), `blake3` 1.8.7, `rrf` (RRF only; `rank-fusion` showed a yanked latest — avoid), `rayon`, `clap`, `serde*`, `tokio`+`axum` (HTTP MCP only), `tracing`.

**Milestone 0.5 (new): fork-or-borrow decision.** Before writing `sect-lexical`/`sect-semantic`/`sect-rank`, read `zg` (zvec-grep, Apache-2.0: ripgrep + BM25 + vector + MCP in one Rust CLI) and `semble_rs` (MIT: BM25 + Model2Vec + RRF). Decide per crate whether to vendor, depend, or reimplement. Record the decision in the repo.

---

## Part C — WS2: `sect-convert` (preprocessing and validators)

### C.1 Role

Turn raw documents — XML, born-digital and scanned PDF, DOCX, XLSX, HTML — into **page elements** an agent can work from, and provide the validators between staging and corpus. Models are used only for *transcription*. Judgment (structure for unnumbered docs, prose xref resolution, amendment mapping, notice interpretation, matrix normalization) is WS3's.

Output per raw document: `work/<raw_sha256>/elements.jsonl` + `pages/*.png` + `report.json`. Cached by input hash.

### C.2 Source registry

`sources.yaml`: `name`, `kind`, `publisher`, `precedence`, `legal_status`, `id_prefix`, `id_pattern`, `acquire` (URL / API / drop folder), `version_detect`, `format_hints` (e.g. `xlsx_matrix`, `scanned: sometimes`), `ocr` (primary/secondary transcriber model strings, DPI).

### C.3 Element extraction by input type

| Input | Path | Output |
|---|---|---|
| **eCFR / CFR bulk XML** | Native parser. `DIV1..DIV8` → tree; `NODE` → `node` and derived `id`; `CROSSREF` → xref candidates; `EFFDNOT` → effective-date and superseded-text records; `AUTH`/`SOURCE` → `authority`/`citation`; `HEAD` → title. No OCR, no layout. | Sections directly, plus xref/effective-date candidates |
| **Federal Register XML** | Native parser for rule documents: effective date, CFR parts affected, and **amendatory instructions** ("§ 1.5 is amended by revising paragraph (a)…") → Action candidates with target id/anchor and kind. | Notice + Action records |
| Born-digital PDF | pdfium/pdf.js text layer + Docling (subprocess) for layout, reading order, tables (TableFormer). VLM only for pages with low text-layer confidence. | Elements with type, text, bbox, reading order, font size |
| Scanned / image-only pages | **Two independent transcriptions per page:** primary **PaddleOCR-VL-1.5** (0.9B, Apache-2.0, best TextEdit 0.035, strong reading order) or GLM-OCR if license permits; secondary an independent-architecture model — **MinerU2.5** or **olmOCR-2** self-hosted, or a cheap general vision API (GPT-5.6 Luna / Qwen3.8 Flash / Gemini Flash-Lite class; **confirm current pricing before selecting**). Per-line fuzzy match; agreeing spans accepted, disagreeing spans flagged `ocr_divergent` with both readings kept. Tesseract as a zero-cost third opinion. Selection criterion for legal text: TextEdit + reading order over table TEDS. | Elements plus divergence flags and per-span confidence |
| DOCX | mammoth → headings/paragraphs/tables | Elements |
| HTML | Readability + DOM headings | Elements |
| XLSX | SheetJS → sheets, merged ranges, cell grid, footnote cells | `grids.jsonl` |

Element schema: `{doc_sha, page, seq, type, text, bbox, font_size, bold, table_grid?, flags[], confidence}`.

### C.4 Deterministic passes

Strip running headers/footers; rejoin hyphenation; native-ID heading pass with `id_pattern`; explicit-ref regex pass (`§ 1.5`, `29 CFR 1.5`, `part 1910`, `paragraph (a)(2) of this section`); glossary detection; table stitching. Output `structure.json`, `xrefs_candidates.jsonl`, `terms_candidates.json`, page images.

### C.5 Validators (run by WS3 before submit, and in CI)

1. `sect index --validate-only` on staging.
2. **Round-trip text check:** section body must fuzzy-match a contiguous span of element text (or XML node text) from its provenance above 0.92 token-level. The `context:` block is excluded from this check (it is not rule text) but must score < 0.8 similarity to the body (no paraphrase prefixes — the CRAwLeR failure mode).
3. **Table cell check:** every numeric/enumerated cell in a normalized table appears in the source grid.
4. **Xref precision:** every link target exists and is active at the section's effective date.
5. **Provenance completeness:** raw hash, locator, `legal_status`, ingest run.
6. **Precedence sanity:** `overrides`/`narrows` targets are base-kind, lower precedence.
7. **Action integrity:** every `amended_by` Action exists, its target matches, and the notice's quoted amendment text is present in the new Expression.

### C.6 Version alignment

`sect-convert align <source> <old> <new>`: match by `node`/`id`, then title, then text; emit `changes.json`. For eCFR, prefer pulling the exact point-in-time XML from the versioner API over diffing bulk snapshots.

---

## Part D — WS3: Ingest harness (Pi)

### D.1 Agents and runtime

| Agent | Trigger | Writes to | Autonomy |
|---|---|---|---|
| **Ingest** | New/changed raw document | `staging/<run_id>/` | Proposes |
| **Verifier** | Each ingest submit | Nothing | Blind second opinion; different provider/prompt; no access to ingest's answers |
| **Notes** | Corpus commit merged | `corpus/notes/` | Free, within schema |
| **Lint** | Nightly + after large merges | `lint/<date>.md` | Reports only |

Built on `pi-agent-core` (agent loop, `AgentContext`, `beforeToolCall`/`afterToolCall` lifecycle) with `pi-ai` for provider abstraction. The seven `sect` verbs and the harness tools are registered as Pi `ToolDefinition`s; the same verbs are served by `sect-mcp` so the Claude Agent SDK consumes them unchanged. **Pin exact package scope and version** — Pi publishes under both `@mariozechner/*` and `@earendil-works/*` with different version numbers; confirm the canonical scope at build time. Pi has no built-in sandbox: ingest runs in a container, and `beforeToolCall` gates writes to `staging/` only.

Every role is configured by a provider/model string; the verifier defaults to a different provider than ingest. The verifier design follows the GrepSeek tutor/planner split: the verifier is answer-blind and must reconstruct the mapping from the same inputs.

### D.2 Ingest loop (encoded in SKILL.md)

1. `sect_map` the scope; classify the document (base / overlay / notice / internal); confirm against the registry.
2. Accept WS2's candidate tree where confidence is high; resolve gaps from elements and page images. For unnumbered sources, propose a hierarchy and synthesize deterministic IDs.
3. Write section bodies **by copying element/XML text**; markdown formatting only. Never paraphrase (validator 2 enforces).
4. Write the `context:` prefix (50–100 tokens; must name at least one referenced section's subject; no paraphrase of the body). Cost is on the order of $1 per million document tokens, once.
5. Normalize tables; flatten matrices.
6. Resolve prose xrefs with `sect_search` (citation short-circuit for explicit ones); pick from real IDs only; record confidence and the search used.
7. Extract inline definitions → `defines`.
8. Overlays: `sect_search` the base corpus for modified sections; propose `overrides`/`narrows` with rationale. **Judgment field → consensus.**
9. Notices: from WS2's Action candidates plus `sect_read` of the current Expression, write the new Expression with `supersedes` and `amended_by`. **Judgment field → consensus.**
10. `staging_validate()`; fix hard failures (max 3 retries).
11. `submit()` with a summary: sections added/changed, xrefs resolved (low-confidence list), overlay/Action proposals with the searches behind them, flags.

Constraints: one run per document; runs serialized per source; idempotent per raw hash.

### D.3 Verification and commit

Thousands of pages; humans cannot review them. Four automated layers; humans see **conflicts** and a **sample**.

1. **Validators** (C.5). Hard failures bounce to the agent.
2. **Evidence checks** on judgment fields: `overrides`/`narrows` target is base-kind, lower precedence, active at the overlay's date, shares ≥1 defined term or embedding similarity ≥ floor, and (for tables) differs in at least one value; `supersedes`/`amended_by` — notice text present in the new Expression, dates consistent, prior Expression active before the new date; prose xrefs — target active and term overlap with the sentence; OCR-divergent spans — resolved or outside rule text.
3. **Blind consensus:** the verifier redoes every judgment field from the same inputs. Agreement → auto-merge, provenance records both runs. Disagreement → human queue.
4. **Acceptance sampling:** N merged items per source per run (default 20, stratified) graded by a human after the fact; observed error rate drives thresholds (relax below 2%, tighten above; every graded error becomes a schema example or validator rule). Formalize sample sizes against a named standard (e.g. ANSI/ASQ Z1.4) before H2.

Tiers: **auto** (layers 1–2 pass; not a judgment field, or consensus agrees) → merge. **conflict** → human resolves; resolution becomes a schema example. **sample** → human grades; never blocks.

Review artifact `review/<run_id>.md` (conflicts only, both proposals + rationales + searches). Merge = staging → `corpus/`, `sect index`, git commit. Rollback = git revert. Runtime backstop: provenance to the page/node; a wrong mapping found later is a one-line front-matter fix plus a schema example.

### D.4 Notes agent

Per merge: cross-source comparisons, digests of what a notice changed, hub pages for heavily-referenced sections. `kind: note`, `sources: [{id, hash}]`, typed wikilinks, every claim cites a section ID. Indexed at lowest precedence with the −0.2 penalty.

### D.5 Lint agent

`sect status` plus: orphans; unresolved refs; terms used but never defined; overlays whose base target was superseded; notes with drifted source hashes; conflicting overlays from one source; judgment fields with single-run provenance; Actions whose target Expression is missing. Emits issues; never edits.

### D.6 Schema governance

`SKILL.md` in the repo with a growing examples section; every reviewer rejection that reflects a convention becomes an example or a validator rule within the week. Schema version recorded in each run's provenance.

---

## Part E — Evaluation

### E.1 Retrieval (WS1)

**Corpora.** (a) Real: 2–3 eCFR titles converted from GPO bulk XML, with point-in-time Expressions from `ecfr.gov/api/versioner/v1/full/{date}/title-{n}.xml` (note: subset params are ignored and whole titles are returned; large titles can time out; eCFR lags the Federal Register by 1–2 business days, so snap dates) and Federal Register rules as notices. (b) Fixture: a small synthetic corpus in the repo for CI.

**Question generation.** CRAwLeR recipe: detect explicit cross-references; referencing section = target, referenced sections = required context; LLM writes a query unanswerable from the target alone; **adversarial filter** removes anything a non-contextual BM25 or vector baseline solves at rank ≤10; assurance prompt. Hand-written questions for the remaining types.

**Types:** locate, id-lookup (citation short-circuit), definition, cross-ref (context required), subtree-completeness ("all sub-items of § X"), overlay, as-of, amendment-history, table, **no-gold** (natural absence) and **wrong-corpus** controls (Agent Retrieval Bench), negative.

**Metrics.** Recall@5, NDCG@10 per type; character-span precision/recall at the snippet level (LegalBench-RAG methodology); exact-match for `define`/`refs`/`as-of`/`map --complete`; abstention accuracy on no-gold; latency p50/p95 per verb. **Gates:** Recall@5 ≥ 0.90 locate/definition; exact-match ≥ 0.95 id/refs/as-of/complete; abstention ≥ 0.90 on no-gold.

### E.2 Conversion (WS2 + WS3)

Golden set: 30–50 hand-corrected pages across born-digital eCFR, scanned Federal Register (pre-1994 scans), tables/matrices, overlay, notice. Metrics: section-boundary accuracy; TextEdit and reading-order edit distance per transcriber; table cell accuracy; xref resolution rate/precision; OCR divergence rate; Action-extraction precision vs human labels; amendment-mapping precision; round-trip pass rate. Gates: boundary ≥ 0.95 born-digital; table cell ≥ 0.98; xref precision ≥ 0.95 at the auto-merge threshold; Action precision ≥ 0.95.

### E.3 End-to-end agent loop

BrowseComp-Plus protocol: fixed corpus, fixed agent and prompt, report **accuracy, evidence recall, average tool calls, tokens, wall time, cost**; N ≥ 3 runs; paired arms: cold (Read/Grep only) vs `sect` vs `sect` + seed vs `sect` + notes. Add a **corpus-size scaling** arm (1 title → 3 titles → 10 titles) to confirm tool calls stay flat, since raw-grep agents double their calls and lose accuracy as corpora grow. Gate: ≥ 30% fewer tool calls, no correctness regression, flat scaling.

### E.4 Ingest quality over time

Auto-merge rate, consensus agreement by field, conflict queue size, sampled error rate, time-to-merge, lint counts. Falling agreement or rising sampled error means the schema needs examples, not looser thresholds.

---

## Part F — Roadmap

### F.1 Milestones

| # | WS | Milestone | Deliverable | Est. |
|---|---|---|---|---|
| 0 | E | Eval + Python prototype | Fixture, question set (CRAwLeR recipe), chunking/ranking prototype with semble. **Gate: locate/definition Recall@5 ≥ 0.85 before any Rust.** | 3–5 d |
| 0.5 | WS1 | Fork-or-borrow | Read `zg` and `semble_rs`; per-crate decision recorded. | 2 d |
| C0 | WS2 | Extractor + OCR bake-off | Docling vs Marker; PaddleOCR-VL-1.5 vs GLM-OCR vs MinerU2.5 vs olmOCR-2 vs one general API on 30 pages (10 eCFR born-digital, 10 scanned FR, 10 tables). Score TextEdit, reading order, TEDS. Pick primary + secondary. | 3–4 d |
| 1 | WS1 | Skeleton | Workspace, core types, corpus walker, front matter, validation, `tree.json`, `read`, `map`, `status` | 1 wk |
| 2 | WS1 | Structure | Xrefs, Actions, terms, tables, precedence, Work/Expression `as-of` with snapping, `refs`, `define`, `map --complete`, `read --history` | 1.5 wk |
| C1 | WS2 | Native parsers + elements | eCFR XML and FR XML parsers (NODE, CROSSREF, EFFDNOT, AUTH/SOURCE, amendatory instructions); PDF/DOCX/HTML/XLSX extraction; dual-transcriber OCR path | 2 wk |
| 3 | WS1 | Exact | `grep` via grep-* crates, rg-compatible output, bounded hits + counts | 2–3 d |
| 3b | WS1 | Sparse n-gram index | Corpus-derived pair weights, literal extraction, mmap table + postings, `--no-index`. **Gate: ≥5× median speedup on a 3-title corpus for typical agent regexes, else cut.** | 1 wk |
| 4 | WS1 | Lexical + semantic | tantivy schema incl. `citations` and `context` fields, model2vec-rs, brute-force cosine, `search` with RRF | 1 wk |
| C2 | WS2 | Validators + align | C.5 validators as library + CLI; C.6 alignment via versioner API | 1 wk |
| 5 | WS1 | Rank + seed | Rerank signals, citation short-circuit, `--expand`, `--seed`, abstention. Hit E.1 gates. | 1 wk |
| 6 | WS1 | Freshness | Fingerprints, incremental index, freshness + counts lines everywhere | 3–4 d |
| 7 | WS1 | MCP + install | `sect-mcp` on rmcp, tool schemas, `sect install`, SKILL.md for answering agents, Pi and Claude Agent SDK examples | 3–4 d |
| H1 | WS3 | Ingest agent v1 | Pi harness, tools as `ToolDefinition`s, SKILL.md loop, staging, submit, context-prefix generation; eCFR titles first | 1.5 wk |
| H2 | WS3 | Verification + commit | Evidence checks, blind verifier, consensus, sampling with a named standard, conflict artifact, merge script | 1.5 wk |
| H3 | WS3 | Overlays + notices | Steps 8–9, Action pipeline end-to-end on real FR rules and one overlay set | 1.5 wk |
| H4 | WS3 | Notes + lint | D.4, D.5, notes penalty, E.3 with notes on/off | 1 wk |
| 8 | E | End-to-end + scaling eval | E.2, E.3 incl. corpus-size arm; results in README | 1 wk |

Dependencies: 0 → 0.5 → 1 → 2 → {3, 4} → 5 → 6 → 7; 3b after 3 and 6. C0 → C1 → C2. H1 needs 2 and C1; H2 needs C2 and 7; H3 needs H2 and 6; H4 needs H2.

**Releases (ship in chunks):** R1 = `sect` after milestone 7 with the eCFR converter and fixture. R2 = `sect-convert` after C2. R3 = harness after H2. R4 = notes + lint after H4. Each with README and eval numbers.

Roughly 16–18 engineer-weeks; with two engineers (Rust on WS1, TypeScript on WS2/WS3) about 8–9 calendar weeks to a first real ingest of three CFR titles plus one amendment set.

### F.2 Two-person order

- Week 1: both on 0, 0.5, C0.
- Weeks 2–5: Rust 1→2→3→4→5; TypeScript C1→C2→H1.
- Weeks 6–8: Rust 6→7→3b; TypeScript H2→H3.
- Week 9: H4 and 8 together.

### F.3 Decisions log

| # | Question | Decision |
|---|---|---|
| 1 | Scanned material | In scope from v1; dual-transcriber OCR. |
| 2 | Overlay formats | Spreadsheet and PDF paths from v1. |
| 3 | Overlay semantics | `overrides` and `narrows` both from v1. |
| 4 | Embedding model | `potion-retrieval-32M` via `model2vec-rs`; no distillation; contextual prefixing instead of late chunking. |
| 5 | Verifier | Answer-blind, different provider; measured vs golden labels before H2. |
| 6 | Indexed regex | Sparse n-grams with corpus-derived weights (3b), gated on measured speedup. |
| 7 | Federation | Single root. |
| 8 | Reference corpus | eCFR + Federal Register; XML flagged `unofficial-xml` in provenance. |
| 9 | Harness | Pi (`pi-agent-core`) primary; Claude Agent SDK via the MCP surface. |
| 10 | License | Apache-2.0. |
| 11 | Languages | Rust for `sect`; TypeScript for WS2/WS3; Docling and OCR models as subprocesses. |
| 12 | Chunk unit | Section/subsection file; split only at paragraph labels. |
| 13 | Versioning | Work / Expression / Action; `--as-of` snaps, current-only default. |
| 14 | Name | `sectgrep` / `sect`, pending registry check; fallback `regsift`. |
| 15 | Retrieval core | Fork-or-borrow decision (0.5) against `zg` and `semble_rs` before writing. |

---

## Part G — Reference material

- Cursor, "Fast regex search: indexing text for agent tools" (2026-03); "Securely indexing large codebases".
- SAT-Graph RAG / Graph RAG for Legal Norms (arXiv 2505.00039; API 2510.06002); CRAwLeR (2606.21676); KG-RAG on CFR (2604.14220); Beyond Probabilistic Similarity (2606.09724); Thai Legal RAG / NitiLink (2502.10868); Chunking German Legal Code (2605.19806); LegalBench-RAG (2408.10343); StateCodes/LaborBench (2508.19365); FDARxBench (2603.19539); Poly-Vector Retrieval (2504.10508); Legal RAG Bench (2603.01710); KG-RAG on legal docs (CEUR Vol-4079); FDA CFR Title 21 KG (2606.28364).
- Direct Corpus Interaction (2605.05242); DCI scaling in Retrieving Interaction Spaces (2606.06880); GrepSeek (2605.29307); Agent Retrieval Bench (2607.24882); BrowseComp-Plus (2508.06600 / ACL 2026); Anthropic, "Introducing Contextual Retrieval".
- OmniDocBench v1.5/v1.6 leaderboards; PaddleOCR-VL-1.5 (2601.21957); GLM-OCR; MinerU2.5; FireRed-OCR; olmOCR-2; dots.ocr; Docling; Marker.
- GPO `usgpo/bulk-data` (ECFR-XML-User-Guide); govinfo.gov/bulkdata/ECFR and /FR; ecfr.gov versioner API; `@us-legal-tools/ecfr-sdk`; `ecfr-mcp`; eCFR Analyzer projects.
- Rust: tantivy, model2vec-rs, rmcp, roaring, grep-*, regex-syntax, comrak, blake3, rrf; instantgrep (dmitri-lerko), fast-grep-rust; zg (zvec-grep), semble_rs, ck, frankensearch.
- Pi agent harness (badlogic/pi-mono); Karpathy "LLM Wiki"; semble; zvec-grep; Graft.

---

## Part H — Research findings and rationale (survey of 2026-09-02)

### H.1 Chunking
"Chunking German Legal Code" (2605.19806) measured subsection and section retrieval as the strongest Recall@10 on the BGB, with fixed windows, semantic clustering, and boundary-prediction chunkers all worse — because statutory boundaries deliberately group conditions and consequences meant to be read together. Thai Legal RAG (2502.10868) reached the same conclusion and added cross-reference augmentation (NitiLink). Consequence: B.2's one-file-per-section rule and the paragraph-label-only split.

### H.2 Structure must be deterministic
"Beyond Probabilistic Similarity" (2606.09724) shows that even context-enriched chunks cannot guarantee descendant completeness or ancestor closure under vector similarity; typed graph traversal is required. KG-RAG on CFR (2604.14220) reports a 70% accuracy gain over vector-only RAG on the CFR using SUPERSEDES/REFERS_TO edges and a recursive reference crawler (authors' own benchmark; magnitude indicative). The CEUR KG-RAG benchmark shows hybrid beats pure-KG, so lexical and vector signals stay. Consequence: `map --complete`, `--expand refs`, `refs` depth, and the rule that structural guarantees never come from ranking.

### H.3 Versioning
SAT-Graph RAG (2505.00039, API 2510.06002) models legal norms as Works with versioned Expressions and reifies legislative events as Action nodes, enabling deterministic point-in-time retrieval and impact analysis. Consequence: B.2's `amended_by`, `actions.jsonl`, `read --history`, `refs --type amends`, and as-of snapping.

### H.4 Contextual prefixes
Anthropic reports Contextual Embeddings + Contextual BM25 cut top-20 retrieval failures by 49% (67% with reranking) at about $1.02 per million document tokens, once. CRAwLeR's ablation shows the contextualizing model matters far more than the embedder, and that the main defect is near-copy or wrong-topic prefixes. Consequence: the `context:` block, indexed in its own field, excluded from the round-trip check, and validated against paraphrase; static embeddings are acceptable.

### H.5 Agent interface
Direct Corpus Interaction (2605.05242) and GrepSeek (2605.29307) show grep-style access is a strong primitive for capable agents, but the DCI scaling study (2606.06880) shows tool calls rising 38.5 → 86.9 and accuracy falling 13.6 points as a corpus grows 100k → 200k documents, worse at 400k. BrowseComp-Plus shows a better retriever raises accuracy (55.9% → 70.1%) while *reducing* search calls (23.23 → 21.74) and cost. Agent Retrieval Bench shows a lexical seed raises success from 0.51 to 0.80 with fewer calls, and RRF gives the best MRR/R@20; agents compensate for weak seeds by spending more calls. Cursor reports 16.8 s → 13 ms for regex via a client-side sparse n-gram index and separate value from semantic search. Consequence: bounded output with counts, the n-gram prefilter, `--seed`, `--expand`, and the scaling arm in E.3.

### H.6 OCR
On OmniDocBench v1.5, GLM-OCR (0.9B, 94.6) and PaddleOCR-VL-1.5 (0.9B, 94.5, TextEdit 0.035, Apache-2.0) lead, with MinerU2.5 (1.2B) close and FireRed-OCR-2B best on TextEdit (0.032) and reading order (0.041); all beat Gemini-3 Pro (90.3) and GPT-5.2 (85.4) on document parsing. Docling is the best structured-output orchestrator and is CPU-viable; Marker is fast in its light mode. Do not compare scores across benchmark versions. Pricing for the named 2026 flash/lite vision APIs was not retrievable in the survey — confirm before selection. Consequence: C.3's primary/secondary choice and selection criterion.

### H.7 eCFR ecosystem
GPO's guide documents `DIV1..DIV8`, `NODE` stable IDs, `CROSSREF`, `EFFDNOT`, `AUTH`/`SOURCE`. The versioner API returns whole titles at any date (subset params ignored; large titles may time out) and lags the Federal Register by 1–2 business days. `@us-legal-tools/ecfr-sdk` (TypeScript, generated from the OpenAPI spec) and `ecfr-mcp` (13 tools, server-side XML parsing, auto date resolution) exist. The XML is not the official legal edition. Consequence: C.3's native parsers, as-of snapping, `legal_status` in provenance, and reuse of the SDK in WS3.

### H.8 Rust components
All chosen crates are current and permissively licensed (versions in B.7). `regex-syntax` exposes literal extraction directly; `usearch` documents brute force as the intended path below ~1M vectors; `rank-fusion`'s latest release showed as yanked so `rrf` is used; `comrak` gives a full CommonMark+GFM AST. `zg` (Apache-2.0, ripgrep + BM25 + vector + MCP) and `semble_rs` (MIT, BM25 + Model2Vec + RRF) are the closest existing artifacts. Consequence: milestone 0.5.

### H.9 Harness
Pi's `pi-agent-core` provides the loop, tool lifecycle hooks, and multi-provider `pi-ai`; two npm scopes with divergent versions require pinning; no sandbox, so containerize. GrepSeek's answer-aware tutor / answer-blind planner is the published pattern for the blind verifier. The Claude Agent SDK TypeScript API was not retrieved in the survey; the MCP surface keeps it a drop-in target. Consequence: D.1.

### H.10 Naming
Taken: `hgrep`, `ordinal`, `canon` (incl. `canon-mcp`, a Rust search tool). Risky: `sx`, `clause`. Clean on negative search: `sectgrep`, `corpusgrep`, `statgrep`, `regsift`, `lexgrep`. Consequence: header decision and the registry-check requirement.

### H.11 Open evidence gaps
Vision-API pricing for the specific 2026 model versions; Claude Agent SDK TS tool-registration specifics; a named acceptance-sampling standard; OCR throughput figures come from single third-party runs; the 70% CFR gain is unreplicated. Each is assigned to a milestone above (C0, 7, H2, C0, E.3 respectively).
