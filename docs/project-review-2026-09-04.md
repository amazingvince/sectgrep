# sectgrep: project, architecture, and correctness review

Reviewed 2026-09-04, starting from sectgrep-spec-v0.4.md, against checkout 1749e98. This is a review of the existing implementation and evidence, with additional local experiments. It does not implement the proposed fixes.

## Assessment

**Keep the project. It has a useful architecture and a plausible reason to exist, but it is not yet a trustworthy, generalized document data store.** It is closest to a structure-aware retrieval and ingestion system for English, hierarchical rules corpora with reasonably good source structure.

Its strongest potential advantage is the combination of exact text, stable references, complete structural navigation, effective-dated versions, and evidence for transformations. Hybrid search and MCP alone do not distinguish it from existing tools. Several of those stronger guarantees currently break on small, ordinary examples: repeated definitions, historical reads, changes to source configuration, decimal disagreements, and edits between verification and merge.

This is more than a cleanup problem. Improving formatting, changing the embedding model, or adding another agent will not fix those failures. The next milestone should make the correctness contract enforceable, then prove ingestion on several genuinely different document families.

The user ambition is also broader than the specification. A.1 deliberately targets rules and guidelines with hierarchy, amendments, dates, and references. A.5 excludes multi-tenant serving, federation, and Windows. A strong implementation of that spec would still need additional design work before promising support for any complex document corpus.

## What I examined and ran

I followed the path from the spec and decisions through acquisition/conversion, element extraction, staging, evidence checks, blind verification, merge, indexing, query execution, CLI/MCP, examples, CI, and evaluation reports. The inventory contains 68 production Rust/TypeScript source files and approximately 15,212 lines, excluding tests, scripts, and prototypes. This is a substantial implementation, but still small enough to correct its central contracts without replacing it wholesale.

I built and tested the current checkout, reran retrieval evaluation, validated the existing corpora, inspected dependency and toolchain declarations, and wrote 16 focused offline experiments against the actual compiled code. Experiments used temporary corpora and injected verifier/OCR inputs; they did not call paid models or modify the curated corpus. Normal tests/evaluation refreshed disposable indexes and build outputs.

| Check | Result | What it establishes |
|---|---|---|
| cargo test --workspace --locked | **48 passed**, zero failures | Existing Rust unit/integration contracts pass, including CLI, MCP, incremental indexing, structural queries, and real-corpus n-gram parity |
| pnpm -r build | Pass | All workspace TypeScript packages build |
| pnpm -r test | **81 passed**, zero failures | Converter 34, harness 28, Pi example 10, Claude SDK example 9 |
| All seven validators on fixture | 44 documents; zero errors, one warning | Fixture passes the current validator definitions |
| All seven validators on merged corpus | 306 documents; zero errors, **237 warnings** | Includes **111 skipped round-trip checks**, so passing does not mean all text was checked |
| Current release retrieval evaluation | Fixture gates pass; real Title 1 locate Recall@5 **0.88**, definition **0.50** | Real queries expose weaker behavior than the fixture; the real results do not control the exit gate |
| cargo fmt --all -- --check | Fail | Formatting is not maintained consistently |
| cargo clippy --workspace --all-targets --locked -- -D warnings | Fail | Stops at three diagnostics in sect-corpus; this is not an exhaustive count of all workspace warnings |
| pnpm audit --prod --json | Two high advisories for xlsx 0.18.5 | Dependency remediation required; exploitability was not dynamically tested |
| Declared Rust baseline | Workspace says 1.80; 56 resolved packages declare newer requirements | The manifest baseline is inconsistent with the resolved dependency set |
| Additional offline probes | 16 experiments completed | Reproductions of the correctness gaps below, beyond the existing suite |

The full n-gram integration test took about 686 seconds on this Windows checkout and passed. That is useful evidence of parity on a fixed corpus; the mutation probe below tests a different property. Windows is explicitly outside the v1 target, so these timings are observations, not a finding that the Linux performance contract failed.

I did not rerun live OCR on the GPUs, live ingest/verifier campaigns, the proposed end-to-end agent scaling experiment, or competing retrieval engines. Existing C0/H1/H2/H3 reports are historical evidence, identified as such below. Comparisons with outside projects are based on their current primary documentation, not a head-to-head performance result.

### What is actually in the data

| Location | Documents / expressions | Works | Actions | Indexed terms | Unresolved references | Overlay relationships |
|---|---:|---:|---:|---:|---:|---:|
| fixtures/corpus | 44 | 43 | 1 | 24 | 0 | 3 |
| corpus | 306 | 288 | 15 | 57 | 121 | 0 |
| corpora/ecfr | 9,376 | 9,376 | 55 | 1,486 | 554 | 0 |

These locations represent different levels of preparation. Converted files are not equivalent to verified, merged files. The merged corpus contains 280 Title 4 files, 15 Title 29 files, one Federal Register notice, and ten Iowa overlay files. It includes 18 superseded expressions. The larger converted corpus contains three eCFR titles and six notices, predominantly one expression per work.

Unresolved references can legitimately point outside a partial corpus. They should be classified as out-of-corpus, unresolved, ambiguous, or malformed rather than treated as one undifferentiated quality count. Likewise, having overlay documents is different from demonstrating successful overlay relationships: the merged corpus currently has no overrides/narrows edges.

## What is good and should be preserved

- **The seven verbs are a strong product interface.** Search, exact matching, reading, references, definitions, hierarchy, and status correspond to real agent tasks. Shared execution through sect-verbs helps keep CLI and MCP aligned.
- **Structure is a first-class retrieval mechanism.** Deterministic traversal is the right foundation for complete lists, ancestry, and references. Similarity search cannot supply completeness guarantees.
- **The project reuses substantial libraries.** Tantivy, ripgrep crates, model2vec, Markdown parsing, and MCP infrastructure carry real work. This is not a handwritten replacement for every search primitive.
- **Raw material, corpus text, and synthesized notes are conceptually separate.** Copying source text instead of asking an agent to rewrite it is an excellent starting constraint.
- **Work/Expression/Action is useful for the target domain.** It can represent amendment history much better than overwriting a vector-store record.
- **There is a real evaluation culture.** Fixtures, retained reports, explicit misses, parity checks, cost measurements, and documented decisions are valuable. Several reports already disclose their limitations candidly.
- **Local files and an inspectable corpus are practical.** There is no need to abandon Markdown to gain stronger publication and indexing consistency.

## Findings, ordered by importance

The spec-to-implementation picture is uneven:

| Spec area | Present implementation | Remaining acceptance gap |
|---|---|---|
| B.3/B.4: seven query verbs, CLI/MCP | Implemented and tested | Scope, time, provenance, and complete expansion need stronger invariants |
| B.6: automatic freshness and incremental indexing | Implemented, with synchronous/background refresh | Dependencies and reader snapshots are incomplete |
| C.1: native and generic conversion | Native XML produces corpus sections; generic formats produce elements | A general elements-to-sections bridge is missing |
| C.3: independent OCR comparison | Implemented; prior bakeoff retained | Numeric semantics and unusable-secondary handling do not support the trust claim |
| C.5: seven validators | Implemented and exercised in CI | Passing allows meaningful omissions, reassigned table values, and skipped source checks |
| D.2/D.3: propose, validate, verify, merge | Substantial working pipeline with real runs | Claim comparison and publication do not bind verified evidence to final content |
| Notes/lint and broad end-to-end evaluation | Described as later work | Do not treat these as completed product capabilities |
| E.1–E.3: quality and agent/scaling evidence | Fixture retrieval gates and several measured milestones | Held-out heterogeneous ingestion, reliable real-corpus gates, and full agent/scaling evidence remain |

P1 means fix before relying on the affected guarantee or broadening automated publication. P2 means material design, reliability, or quality debt that should enter the next implementation plan. These are project-review priorities, not vulnerability severity scores.

### 1. P1 — A verification result is not bound to the content that gets published

**Reproduced:** A normal-shaped submit/auto-verdict was created for a staged section. Its body was then changed. mergeRun published the changed body and added both ingest and verifier provenance tags. The experiment constructs the verdict rather than running a live verifier; it demonstrates the missing content binding directly.

[merge.ts:77](C:/Users/amazi/code/sect/packages/sect-harness/src/merge.ts:77) trusts submit.json and verify.json, then reads the current staging files. There is no verified-content digest or final equivalent validation over the exact output bytes. The merge also rewrites metadata and de-links some structural listings after the original judgment.

The same function writes files to corpus before indexing. At [merge.ts:191](C:/Users/amazi/code/sect/packages/sect-harness/src/merge.ts:191), an index failure is logged, and execution can continue to a Git commit. A missing binary also permits publication without refresh. Git provides a history and a way to undo changes; it does not make the multi-file publication atomic.

**Change:** Produce an immutable candidate manifest covering every published file, source configuration, prior expression, source hash, verification recipe, and expected corpus generation. Bind both validators and verifier results to that manifest. Validate the final transformed candidate, build its indexes, then publish one generation atomically. Failure should leave the previous generation usable. Require a corpus-wide publication lock and reject a stale base generation. Commit only the exact files belonging to that publication.

**Acceptance:** Editing one byte after verification invalidates approval. Missing files, failed indexing, interrupted publication, and concurrent merges leave readers on one valid generation. A retry is idempotent.

### 2. P1 — “Consensus” can mean agreement on materially different answers

**Reproduced:** The ingest agent selected DOC:T1#a and the verifier selected DOC:T1#b. The judgment reports agree=true. An Action with kind=remove also agreed with a verifier Action with kind=add when the target and anchor matched.

[verifier.ts:194](C:/Users/amazi/code/sect/packages/sect-harness/src/verifier.ts:194) compares xref base IDs without requiring anchor equality. Action comparison records the verifier's kind in an explanation but does not require it to match. A single candidate can be classified deterministic and accepted even without a corresponding verifier answer. Candidate uniqueness does not prove the instruction's operation or paragraph is correct.

There is a further calibration issue: converter-proposed Action targets enter candidate preparation. The verifier is blind to the final ingest answer, but not necessarily independent of every upstream proposal. Shared candidates and shared extraction mistakes can yield shared wrong answers.

**Change:** Compare typed claims, including relation kind, source and target expression, anchor/span, operation, and applicability. Missing required judgments must remain unverified. Deterministic exceptions should require parser-backed evidence of the complete claim. Give the verifier the relevant source instruction and target text, and measure correctness against independent labels separately from agreement.

**Acceptance:** Wrong anchor, wrong operation, missing answer, and a sole incorrect candidate all fail the publication gate. Valid equivalent encodings still normalize to the same claim.

### 3. P1 — Round-trip and table validators accept changes in meaning

**Reproduced:** Removing “not” from “shall not permit” produced no round-trip issue. Swapping the values assigned to Lead and Mercury produced no table-cell issue.

[validators/index.ts:296](C:/Users/amazi/code/sect/packages/sect-convert/src/validators/index.ts:296) checks how much of the submitted text appears in the source. A deletion can leave all remaining output tokens present and score perfectly. The derived-expression path uses a bag of tokens from the prior expression and Action text, which further discards ordering. [tableCells:367](C:/Users/amazi/code/sect/packages/sect-convert/src/validators/index.ts:367) largely checks membership of numbers/enumerated values, not their association with row labels, column headers, units, or footnotes.

This exposes a weakness in the specification as well as the implementation. A fuzzy match threshold and value membership are useful anomaly detectors; they do not establish that output is quotable as the rule.

**Change:** For native copied text, validate ordered source spans with a narrow, explicit normalization policy. Check coverage in both directions when a whole section is expected. Treat negation, comparators, numbers, units, and references as protected content. Validate tables as structures with cell coordinates, header associations, spans, and notes. For composed expressions, validate the actual edit operations and resulting ordered text, not a word inventory.

**Acceptance:** Deleted negation, omitted exception paragraphs, reordered clauses, decimal changes, and swapped table values are rejected. Permitted line-wrap and typographic transformations pass with an auditable transform record.

### 4. P1 — OCR agreement erases decimal differences; unverified OCR is not held

**Reproduced:** Comparing “The limit is 1.0 mm.” with “The limit is 10 mm.” returns agrees=true, no divergent flags, and confidence=1 for the merged line.

The normalizer in [dual.ts:37](C:/Users/amazi/code/sect/packages/sect-convert/src/ocr/dual.ts:37) removes periods before checking numeric differences. It also strips other punctuation that can be significant in technical material. This defeats the stated intention to flag digit-related differences.

When the secondary transcription is unusable, the pipeline emits ocr_unverified. [evidence.ts:203](C:/Users/amazi/code/sect/packages/sect-harness/src/evidence.ts:203) specifically checks ocr_divergent. An offline experiment with unverified elements and unavailable raw material yielded no evidence failure and zero validation errors, although provenance warnings were present.

**Change:** Preserve decimal/grouping conventions, signs, operators, and units during numeric comparison. Separate “two readings agree” from “the reading is correct.” Model missing or unusable verification explicitly and hold affected quotable spans until a configured resolution path supplies evidence.

**Acceptance:** Decimal shifts, minus signs, inequality operators, and secondary failure cannot produce a clean verified result. Test multiple numeric locales rather than deleting punctuation globally.

### 5. P1 — Missing or unresolvable provenance can pass publication validation

**Observed in real data:** All seven validators returned zero errors for the 306-document merged corpus, while 111 round-trip checks were skipped because source locators could not be resolved. These include leaf rule sections, not only generated container listings.

For example, Title 4 section 28.1 uses a locator of the form //DIV8[@NODE='']. [ecfr.ts:479](C:/Users/amazi/code/sect/packages/sect-convert/src/ecfr.ts:479) constructs NODE-based locators even when the source representation lacks that attribute. [roundTrip:320](C:/Users/amazi/code/sect/packages/sect-convert/src/validators/index.ts:320) treats unavailable source text as a warning. Missing raw material likewise produces a hash-not-verified warning.

**Change:** Make “passed,” “failed,” “not applicable,” and “not checked” distinct outcomes. Inspection of a partial corpus can remain permissive; promotion to a verified corpus should require all applicable checks. Each source adapter should generate a locator that resolves uniquely in the actual retained raw file. Support structural-path or element-ID fallbacks when native IDs are absent.

Expose this evidence in the query API as well. The current [ReadResult](C:/Users/amazi/code/sect/crates/sect-query/src/lib.rs:70) includes the corpus path, source name, and legal status, but not the raw artifact hash/locator or verification outcome. A caller must inspect other files to recover the evidence promised by A.4. Add a compact evidence object or a stable evidence handle that resolves through the tool surface.

**Acceptance:** Every published quotable span resolves to its raw artifact and passes a hash check. An intentionally unavailable source is visibly unverified and cannot silently acquire verified provenance.

### 6. P1 — Definitions lose scope, historical versions, and sometimes their text

**Reproduced:** Two chapters define “Widget” differently. define Widget --scope DOC:A returns chapter B's definition. A query as of 2021 returns B's 2025 definition despite a 2020 expression being available.

[graph.rs:196](C:/Users/amazi/code/sect/crates/sect-struct/src/graph.rs:196) stores one term record per slug, overwriting other occurrences. [define:370](C:/Users/amazi/code/sect/crates/sect-query/src/lib.rs:370) retrieves that global record; scope filters usages, not the chosen definition. Its historical check asks whether the work existed then rather than selecting the appropriate definition expression.

The body extractor in [document.rs:283](C:/Users/amazi/code/sect/crates/sect-corpus/src/document.rs:283) also assumes a narrow emphasis-at-line-start convention. In the merged corpus, **44 of 57 stored term records have empty definition text**. A direct define Act query reports defined=true with an empty string and line 0. The converted corpus has 319 repeated term names across works, so collision handling is fundamental, not an exotic edge case.

**Change:** Store definition occurrences keyed by normalized term, declaring scope, expression, and source span. Resolve from the requested location through an explicit applicability rule, and return ambiguity when necessary. Extract spans from parsed structure or converter evidence rather than a single Markdown formatting pattern. A declared term with missing text should not report successful definition retrieval.

**Acceptance:** Repeated terms in chapters and sources, multiple historical definitions, paragraph-prefixed terms, and multi-paragraph definitions all resolve correctly. The real Title 1 “Filing” query should no longer jump to a Title 29 definition.

### 7. P1 — Historical text is combined with current structural metadata

**Reproduced:** Reading a 2020 base section as of 2021 includes an inline narrowed-by marker for an overlay effective in 2027. Historical search also exposes that future relationship.

[tree.rs:89](C:/Users/amazi/code/sect/crates/sect-struct/src/tree.rs:89) keeps current title, parent, context, anchors, and overlay lists at Work level. [read:107](C:/Users/amazi/code/sect/crates/sect-query/src/lib.rs:107) can select an older expression body while still using current node metadata. Chunk construction similarly draws contextual metadata from that node. Reference expansion also needs consistent expression filtering.

A separate probe shows that an undated “current” query selects an unsuperseded expression effective in 2099. That follows the implementation's “latest available” rule; whether it is a bug depends on the intended default. The product must distinguish latest available from currently effective rather than leave the distinction implicit.

**Change:** Make the relevant hierarchy, definitions, relations, and contextual prefixes expression-aware. Carry a single resolved temporal context through every verb and expansion. Specify the default clock or corpus snapshot date. Preserve both effective time and observed/imported time if later corrections must be explained.

**Acceptance:** Before/after queries cannot leak future titles, moved parents, anchors, definitions, or overlays. Tests should include future-effective material, repeals, corrections, and amendments that move a section.

### 8. P1 — Freshness does not cover every dependency, and exact grep can miss matches

**Reproduced:** Changing _source.yaml precedence from 10 to 99 leaves status=fresh. An ordinary index reports noop and retains precedence 10; a full rebuild reports 99.

**Reproduced:** With the n-gram prefilter enabled, modifying an existing .txt file or adding a new .txt file leaves freshness=fresh. Indexed grep returns zero matches for a new term; brute-force grep returns one.

[index build:369](C:/Users/amazi/code/sect/crates/sect-index/src/lib.rs:369) and [freshness check:696](C:/Users/amazi/code/sect/crates/sect-index/src/lib.rs:696) rely on a corpus walk centered on Markdown documents. The exact-search file universe is broader. Registry and other sidecar dependencies are not fully represented in the fingerprint contract.

**Change:** Define the inputs of each derived artifact explicitly. Track source registries, table sidecars, every exact-search candidate file, and index recipe versions. If a prefilter cannot prove freshness for the complete searched file set, bypass it. Exact search must never trade soundness for a stale acceleration structure.

**Acceptance:** Compare indexed and brute grep after file creation, deletion, rename, and content change for every supported exact-search file type. Registry-only edits must rebuild all affected metadata. Report freshness relative to a specific generation, not just the Markdown stat pass.

### 9. P2 — Incremental indexing misses changes inherited from ancestors

**Reproduced:** Change a parent title to “zephyrcalibration.” After incremental indexing, lexical search scoped to its child returns no hit. After full indexing, it returns the child. The displayed breadcrumb already contains the new parent title in both cases.

[index.rs:561](C:/Users/amazi/code/sect/crates/sect-index/src/lib.rs:561) updates lexical and vector entries for reparsed expressions, although other chunks can change when their ancestors or source metadata change.

**Change:** Compare the digest of the complete derived chunk, including inherited context and recipe version, or maintain a dependency graph that invalidates affected descendants. Full and incremental builds should produce equivalent logical results.

**Acceptance:** Parent title, hierarchy, source metadata, chunking policy, and context changes produce equivalent results after full and incremental builds, including semantic entries.

### 10. P1 — Multi-layer index updates do not provide a consistent reader snapshot

**Code-path finding; crash/concurrency behavior was not stress-tested.** [index.rs:540](C:/Users/amazi/code/sect/crates/sect-index/src/lib.rs:540) writes structural files before lexical/vector updates complete. The build lock prevents overlapping builders, but readers do not pin a single published generation. [read_body:796](C:/Users/amazi/code/sect/crates/sect-index/src/lib.rs:796) reads the current corpus file, which may differ from the bytes represented by loaded metadata.

Individual atomic renames or Tantivy's own commit do not make the entire corpus/tree/graph/chunk/vector combination atomic. Background refresh makes this more relevant because serving during updates is an intended feature.

**Change:** Build immutable generation directories and switch a small manifest pointer after success. Readers retain their generation for the operation. A small transactional catalog can coordinate generation metadata and run state while Markdown remains the inspectable content representation. SQLite's documented [atomic commit behavior](https://sqlite.org/atomiccommit.html) is a useful reference for the required publication semantics; simply adding SQLite without coordinating file generations would not solve the problem.

**Acceptance:** Fault injection at each build stage and reads during refresh return a complete old or new generation. Recovery detects and discards incomplete builds.

### 11. P1 for the generalized goal — Generic extraction does not connect to generic ingestion

**Reproduced:** A simple HTML file successfully extracts two elements. Passing that extraction output to the ingest harness fails because there is no _source.yaml. More fundamentally, the harness enumerates Markdown sections rather than compiling the generic elements/structure output into corpus sections.

[extract.ts:74](C:/Users/amazi/code/sect/packages/sect-convert/src/extract.ts:74) produces the generic work artifacts, while [ingest.ts:187](C:/Users/amazi/code/sect/packages/sect-harness/src/ingest.ts:187) expects existing Markdown and [ingest.ts:261](C:/Users/amazi/code/sect/packages/sect-harness/src/ingest.ts:261) requires a converted source registry. Supplying the registry alone does not supply the missing sections. Native eCFR and specialized overlay paths bridge parts of this gap; that is not an arbitrary-document pipeline.

**Change:** Implement an explicit document-to-sections compiler between extraction and enrichment. It must assign stable IDs, preserve ordered block ranges and source evidence, represent unnumbered sections and tables, and expose uncertain structure for review. Agents can propose boundaries and relations where necessary, but source text should still be assembled deterministically from retained blocks.

**Acceptance:** Starting with only raw HTML, DOCX, a scanned manual, and a spreadsheet plus minimal source configuration, one documented workflow produces valid, navigable, traceable corpus content. No hand-authored intermediate Markdown should be required.

### 12. P2 — Cache and run identity describe raw bytes, not the whole computation

**Reproduced:** Extract HTML without a section pattern, then request extraction with a section pattern. The second request returns the cached result and leaves native_id null. The cache key does not account for the changed recipe.

**Reproduced:** Add a second input document with a different raw hash. rawHashOf returns the original first document's hash. [ingest.ts:99](C:/Users/amazi/code/sect/packages/sect-harness/src/ingest.ts:99) returns the first encountered raw hash where present. That is inadequate identity for a generalized multi-document run.

[elements/work.ts:21](C:/Users/amazi/code/sect/packages/sect-convert/src/elements/work.ts:21) caches by raw hash. Model/adapter versions, OCR policy, section patterns, schema versions, selected subsets, and the corpus generation used for enrichment can all change the output without changing the raw bytes.

**Change:** Separate raw artifact identity from extraction recipe identity, enrichment run identity, and publication identity. Hash the ordered input manifest and effective configuration. Keep costly extraction reusable independently of downstream enrichment. Give the shared run ledger transactional updates; per-source locks alone do not serialize writes to a shared ledger.

**Acceptance:** A meaningful recipe/input/base-generation change produces a distinct run; an identical replay reuses the correct artifacts. Concurrent unrelated sources do not lose ledger entries.

### 13. P2 — Structural completeness has silent limits and missing integrity checks

**Reproduced:** A section with 15 references returns only 12 expanded references. [query.rs:753](C:/Users/amazi/code/sect/crates/sect-query/src/lib.rs:753) applies take(12) without a corresponding truncated marker/cursor. Expansion also deduplicates by Work, which can discard distinct target anchors.

**Reproduced:** A two-node parent cycle passes validate-only with zero errors. Some ancestry paths use fixed guards, while recursive complete-map traversal lacks an equivalent cycle rejection. I did not deliberately trigger a stack overflow.

**Change:** Preserve bounded responses, but make bounds explicit with total counts and continuation. Define completeness over IDs plus anchors and the chosen expression. Validate hierarchy acyclicity, root reachability, parent consistency, and version-chain integrity before index publication. Traversals should still have defensive visited sets.

**Acceptance:** A caller can retrieve all references without guessing what was omitted. Cycles are rejected with the offending path; malformed data cannot hang or crash complete traversal.

## Why the evaluation currently overstates readiness

The fixture is useful regression coverage, but it is too small and too tailored to establish generality. Its term names do not repeat; the real converted corpus has hundreds of repeated names. The fixture therefore rewards a global term map that fails an ordinary multi-title query.

The fresh [M5 rerun](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/m5-rerun.md) shows:

- Fixture locate Recall@5 0.95 and definition Recall@5 1.00.
- Wrong-corpus abstention accuracy **0.40 on five questions**, excluded from the gate.
- Only two cross-reference search questions remain in the filtered adversarial category; the all-question result is also reported, but two questions cannot support a broad claim.
- Real Title 1 locate Recall@5 **0.88 on 46 questions**, below the spec's 0.90 target. Definition retrieval is **0.50 on two questions**. Real results do not cause a failing process exit.
- Search p95 was 145 ms on fixture questions and 523 ms on the Title 1 query set against the larger converted corpus, including process startup. These are environment-specific measurements, not an engine comparison.

The existing [H2 report](C:/Users/amazi/code/sect/eval/results/h2.md:7) reports reference recall 0.675 and defined-term precision 0.778 in its fixture comparison. The existing [H3 report](C:/Users/amazi/code/sect/eval/results/h3.md:13) reports Action target/paragraph precision **12/15 = 0.800** against agent-drafted labels while the verifier agrees on 15/15. It composes 18 works against 20 changed works in the versioner; only 10 of those 18 compositions are text-identical to the versioner. The other eight need adjudication, not an assumption that every difference is material or harmless. Its overlay results have no proposed overrides or narrows, so they do not demonstrate real positive overlay mapping.

The [C0 OCR report](C:/Users/amazi/code/sect/eval/results/c0.md:3) explicitly says the scan reference is transcriber consensus, with 106 of 727 lines unconfirmed and an olmOCR reference-arm bias. This is an honest agreement study, not independent scan accuracy ground truth. Production OCR recipe changes also need a new evaluation or an explicit statement that the previous result does not transfer automatically.

[sampling.ts:90](C:/Users/amazi/code/sect/packages/sect-harness/src/sampling.ts:90) chooses the first items in deterministic ID order across strata and judgment categories. This is useful targeted review, but it cannot establish a representative corpus error rate. It samples auto-tier verdicts rather than being intrinsically bound to the exact final published lot. The code's claim to follow Z1.4 should be narrowed or backed by a fully specified sampling plan; this review did not verify conformance to that standard. Even a genuinely random sample of 20 with zero errors gives a one-sided 95% binomial upper bound of about **13.9%**, not proof of an error rate below 2%.

**Change the acceptance system:** Make real-corpus, wrong-corpus, duplicate-definition, temporal, provenance, and mutation checks first-class gates. Keep development/tuning data separate from a held-out set. Report extraction accuracy, claim correctness, agreement, retrieval quality, and final answer quality independently. “Checked 306 documents” must distinguish passed from skipped checks.

## Comparison with what already exists

The following comparison is architectural, based on primary sources checked during this review. It does not assert that a competitor will outperform sect on this machine or dataset.

| Existing project / approach | Relevant capability | What sect should learn or reuse |
|---|---|---|
| [QMD](https://github.com/tobi/qmd) | Local Markdown retrieval with BM25, vector search, query expansion, RRF, local reranking, contextual collections, and MCP | The most direct baseline for ordinary agent knowledge-base search. Run the same converted corpus through it. Sect's justification must come from trustworthy structure, time, and evidence or a measured efficiency advantage. |
| [ck](https://github.com/BeaconBay/ck) | Local semantic/hybrid grep and search for humans and agents | A useful Rust-oriented comparison for exact/hybrid retrieval, indexing ergonomics, and CLI output. Specialized legal relationships remain sect's responsibility. |
| [Docling](https://docling-project.github.io/docling/usage/supported_formats/) | Multi-format conversion with a unified structured document representation | Evaluate an adapter into a richer intermediate representation before extending custom PDF/layout heuristics. Retain native XML adapters where they provide better fidelity. A weak result on one OCR bakeoff is not a reason to ignore its document-model design. |
| [Unstructured](https://docs.unstructured.io/open-source/concepts/document-elements) | Typed document elements and associated metadata | Borrow the discipline of explicit element types, hierarchy, and provenance. Format support should describe retained structure and known losses, not just whether text was extracted. |
| [PageIndex](https://github.com/VectifyAI/PageIndex) | Hierarchical document indexing and reasoning-based retrieval | A relevant baseline for long manuals and documents with useful tables of contents. Reasoning over a hierarchy and deterministic completeness are different properties; measure both. |
| [Haystack](https://docs.haystack.deepset.ai/docs/retrievers) | Composable retrieval pipelines and document-store integrations | Keep extractors, retrievers, rankers, and enrichment replaceable. Avoid coupling the corpus contract to a single model/provider. There is no need to adopt the whole framework just for this principle. |
| [Vespa](https://docs.vespa.ai/en/learn/tutorials/hybrid-search) | A serving platform for hybrid retrieval and configurable ranking | A future option if measured scale or serving requirements outgrow the local design. Introducing it now would add deployment complexity without repairing the current semantic bugs. |
| [Akoma Ntoso / LegalDocML](https://docs.oasis-open.org/legaldocml/akn-core/v1.0/akn-core-v1.0-part1-vocabulary.html) | A mature vocabulary for legal documents and Work/Expression/Manifestation identity | Map the legal profile to established concepts instead of inventing all legal semantics. Distinguish an expression from its PDF/XML/HTML manifestations and preserve their relationships. |

My build-versus-borrow recommendation is selective: keep sect's small query interface and structural/temporal layer; benchmark commodity search instead of claiming novelty there; borrow richer extraction representations and proven transactional primitives; invest custom work in source adapters, applicability, verification, and reproducible publication.

The spec's research summary should also be less absolute. The cited [German legal chunking study](https://arxiv.org/abs/2605.19806) supports section-aware evaluation in its legal setting; it does not prove one segmentation policy is best for spreadsheets, scientific papers, or every complex corpus. [Anthropic's contextual retrieval work](https://www.anthropic.com/engineering/contextual-retrieval) supports testing contextual prefixes, but does not by itself validate this exact embedder, prefix model, or corpus. [LegalBench-RAG](https://arxiv.org/abs/2408.10343) is a useful reference for evaluating fine-grained supporting text rather than only whether a section ID was retrieved.

## What “generalized” should mean in this project

Do not flatten everything into a legal section with an effective date. Generality should mean a common navigable document model with optional domain profiles and honest capability reporting.

| Core entity | Required responsibility |
|---|---|
| Raw artifact / manifestation | Immutable bytes, hash, media type, acquisition metadata, source identity; multiple formats can represent related content |
| Document / work | Stable logical identity independent of a path or one imported file |
| Revision / expression | Content version, optional effective interval, observed/imported time, explicit supersession/correction relationships |
| Block / section | Ordered typed structure: heading, paragraph, list, table, cell, figure, caption, note; stable local identity and parent/order |
| Evidence span | A precise mapping to raw offsets, XML/DOM locations, page regions, or worksheet cells; transformations recorded explicitly |
| Relation / claim | Typed source and target spans/expressions, applicability, evidence, verification status, and ambiguity |
| Published generation | Exact input and output manifests, schema/recipe versions, verification results, and a consistent query snapshot |

The legal profile can add jurisdiction, precedence, normative status, amendment operations, defined-term scope, and in-force resolution. A technical manual may instead need product/version applicability and warning blocks. A spreadsheet needs cell topology, units, formulas or their provenance, and merged headers. An internal policy collection may need ownership and review dates without pretending those are legal effective dates.

The current genericity work is a useful beginning, but changing ID prefixes is not sufficient. [cite.rs:50](C:/Users/amazi/code/sect/crates/sect-corpus/src/cite.rs:50) still has CFR-oriented citation detection and part-number assumptions. Other routines use English definition patterns, ASCII-oriented slugs, and English lexical analysis. HTML/office extraction also needs an explicit policy for links, nested lists, table spans, and location fidelity. Multilingual and poorly structured corpora are unproven capabilities, not automatic consequences of accepting text.

Add an adapter contract that reports which capabilities are available: stable native IDs, exact source spans, page geometry, table topology, version dates, citation resolution, and language support. Missing metadata should remain unknown; it should not be filled with a confident legal-looking default.

For usability, retain the seven verbs but make every response explain its scope, selected version, source location, verification state, and completeness. Add clear ambiguity responses for definitions/references and actionable status summaries for skipped checks and unresolved targets. The next important operator interface is a source-versus-candidate review view with exact diffs and resumable decisions. Finishing a synthesized notes layer should come after the corpus it summarizes is trustworthy.

## Code quality and cleanup

The main quality issue is **duplicated semantic rules and permissive boundaries**, not an excessive quantity of code. Rust and TypeScript each interpret front matter, references, anchors, dates, and provenance. TypeScript frequently crosses those boundaries using loose records/casts. Successful builds do not prove the two implementations interpret the same document identically.

A concrete within-TypeScript contract mismatch is also visible: extracted table elements use [table_grid](C:/Users/amazi/code/sect/packages/sect-convert/src/elements/types.ts:19), while [overlay rendering](C:/Users/amazi/code/sect/packages/sect-convert/src/overlay.ts:52) checks a separately declared cells field after casting parsed JSON. Such an element falls back to its text instead of the structured table renderer. This was identified by inspection, not a separate live conversion experiment. Reusing the actual element type and validating serialized boundaries would prevent this class of drift.

Prioritize cleanup in this order:

1. **Define shared contracts.** Add a versioned machine-readable schema and a cross-language conformance corpus. Test the same valid and invalid records through both implementations. Make unknown/unsupported fields and migration behavior deliberate.
2. **Extract cohesive modules from large files.** sect-query/src/lib.rs is 1,060 lines, sect-index/src/lib.rs 890, validators/index.ts 646, and harness/tools.ts 523. Separate temporal resolution, definition resolution, publication, freshness/dependencies, and individual validators. More crates are not automatically better.
3. **Consolidate parsing.** Repeated regular-expression interpretations of IDs, links, front matter, anchors, and section bodies are a source of disagreement. Use shared typed structures and parser outputs within each language, backed by cross-language fixtures.
4. **Make release checks real.** Apply rustfmt, fix clippy, and add both to CI. Resolve the Rust baseline against the locked graph and test that baseline in CI. Current CI uses stable, so it cannot establish the advertised 1.80 minimum.
5. **Update the spreadsheet dependency.** The installed xlsx 0.18.5 is flagged for [prototype pollution](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) and [ReDoS](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9). Its file-reading path is relevant to this product. Follow the publisher's [installation guidance](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) for a maintained release and pin it reproducibly; a routine npm-version bump may not reach the maintained distribution. Re-run spreadsheet conversion fixtures after changing it.
6. **Reconcile documentation and versions.** README says H3 is done and later says “Next: H3.” Release tags and the runtime/package 0.1.0 version do not tell one consistent story. The spec, decisions, spec-change proposals, and GOAL should distinguish implemented, measured, and accepted behavior. Some deviations were explicitly authorized and recorded; do not mistake every difference from v0.4 for an implementation error.
7. **Keep research artifacts, but separate their role.** The prototype, bakeoff outputs, and historical reports are useful evidence. Freeze and label them as research baselines rather than maintaining parallel product semantics. Do not delete the fixtures or reports merely to make the repository smaller. Generated indexes, temporary runs, and local logs should have retention/cleanup commands scoped to explicit directories.

The three observed clippy blockers are regex creation inside a loop at cite.rs:65, consecutive replacements at document.rs:279, and a nonminimal boolean expression at validate.rs:109. They are straightforward cleanup. The correctness findings above deserve substantially more attention than these lint diagnostics.

## Recommended implementation sequence

### Phase 1: establish that verified means verified

Fix findings 1–8 and 10 first: content-bound verification, complete claim comparison, exact copied-span checks, numeric OCR, fail-closed provenance, scoped/historical definitions, temporal metadata, complete freshness dependencies, and atomic publication. Add the focused counterexamples as regression tests in their owning packages.

Then re-audit the existing merged corpus under the stronger checks. Repair source locators and empty definitions, adjudicate nonidentical composed expressions, and regenerate verification records for the exact resulting bytes. Do not preserve old “verified” labels merely because a previous weaker gate passed.

Exit criterion: no verified item has skipped applicable checks; full/incremental builds agree; historical queries and duplicate terms are correct; interruption cannot expose a partial generation.

### Phase 2: prove the document-to-corpus bridge

Implement the generic section compiler and adapter capability contract. Use a richer element model, with a Docling/Unstructured comparison focused on fidelity rather than only OCR speed. Preserve native XML advantages. Separate legal applicability from generic document structure.

Exit criterion: a documented raw-file workflow succeeds on five corpus families with no manually written intermediate sections:

- Regulations with dated notices and a real positive local overlay.
- A technical manual with tables, warnings, figures, and cross-references.
- A scanned, multi-column document with decimal limits and footnotes.
- Mixed internal policies in DOCX/HTML with repeated headings/terms and missing dates.
- Spreadsheet matrices with units, merged headers, formulas, and repeated labels.

Include a non-English sample before claiming multilingual support. Use unknown dates and ambiguous references deliberately; successful abstention is part of the contract.

### Phase 3: demonstrate a measurable reason to choose sect

Run a held-out benchmark with the same source corpus and questions across exact grep, BM25, BM25 with context, the current hybrid, and QMD. Add a hierarchy/reasoning baseline such as PageIndex for long-document tasks where appropriate. Keep source/normalization differences visible so extraction quality does not masquerade as retrieval quality.

Measure supporting-span recall and precision, complete-set accuracy, version correctness, definition ambiguity, out-of-corpus abstention, and reference/overlay correctness. Then run the E.2/E.3-style answering-agent experiment: task success, unsupported claims, tool calls, tokens, cost, and latency as corpus size and distractors increase. Use multiple runs and report uncertainty; a single favorable trace is not an acceptance result.

A practical starting set is roughly 200 independently labeled tasks across those families, with smaller exact invariant suites for each adapter. Keep a separate tuning set. Repeat measurements when the OCR, contextualization, ranking, or verification recipe changes. Do not add a reranker or new embedding model until the ablation shows what it improves and what it costs.

### Phase 4: improve operator experience and maintainability

Build a compact source/candidate comparison and conflict-resolution workflow, then notes/lint, performance tuning, and packaging. Finish schema/version migrations and reproducible release checks. Choose a serving database or distributed system only when measured requirements exceed the local generation model.

## Reproduction and evidence

The review's working evidence is under [review/project-audit-2026-09-04](C:/Users/amazi/code/sect/review/project-audit-2026-09-04). That directory follows the repository's existing ignored-review convention; the report itself is in docs.

- [probes.mjs](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/probes.mjs) and [probes.json](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/probes.json): 16 offline counterexample experiments and captured outputs. Run from the repository root after building Rust and TypeScript: node review/project-audit-2026-09-04/probes.mjs. The script creates a new temporary corpus root and writes results beside itself. It records observations; it is not yet a pass/fail regression suite.
- [inventory.json](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/inventory.json): source inventory and the three corpus snapshots, including empty/repeated definitions.
- [cargo-test.log](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/cargo-test.log), [pnpm-build.log](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/pnpm-build.log), and [pnpm-test.log](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/pnpm-test.log): build and test evidence.
- [corpus-validation.json](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/corpus-validation.json) and [fixture-validation.json](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/fixture-validation.json): complete seven-validator outputs with the raw/work locations supplied.
- [m5-rerun.md](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/m5-rerun.md): current release evaluation, saved separately from the historical M5 report. The existing runner built the release binary; only its output destination was overridden.
- [fmt.log](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/fmt.log), [clippy.log](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/clippy.log), [pnpm-audit.json](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/pnpm-audit.json), and [msrv.json](C:/Users/amazi/code/sect/review/project-audit-2026-09-04/msrv.json): release hygiene and dependency evidence.

The decision I would make now is to fund a correctness-and-generality milestone for the existing codebase. Its architecture is worth developing, but the next release should earn the terms “verified,” “as-of,” “complete,” and “fresh” on ordinary counterexamples before broadening the product claim.
