# Sect: reliable Rust search across complex document corpora

Approved 2026-09-04. The original product remains a local search/navigation engine:
exact, lexical, semantic, and structural retrieval with relationships that find
otherwise missed evidence. `current-system-repairs.md` tracks the reliability work.

## Decisions

- Rust executes indexing, queries, ranking, traversal, filters, and context assembly through the seven existing CLI/MCP/library verbs.
- TypeScript orchestrates ingestion with replaceable native/parser/model adapters. Hosted models are explicitly optional during ingestion; queries never require network access.
- Support Windows and Linux. Qualify 100,000 searchable units and measure one million as a stress case.
- Retain portable Markdown and JSON/JSONL evidence/metadata as authoritative artifacts; indexes are rebuildable. No migration requirement.
- Prove mortgage/lending guidelines and both machine-learning and biomedical papers; keep eCFR regressions.
- Retrieve evidence and relationships; do not implement case-specific underwriting decisions or generated scientific conclusions.

## Corpus and ingestion

A versioned Rust-owned interchange schema describes documents/revisions, addressable
sections and regions, native source locators, scoped concepts/aliases/definitions,
mentions, and typed evidence-backed relationships. Generate JSON Schema and TypeScript
types and validate boundary data at runtime. Preserve original parser artifacts.

Profiles provide identifiers, structural units, metadata fields, vocabulary, relation
types, and context rules. Common relations cover hierarchy, references, definitions,
aliases, revisions, and mentions. Lending adds applicability, exceptions, product,
borrower, income, and documentation concepts. Research adds citations, methods,
datasets, populations, measurements, and reported results. eCFR keeps legal-specific
semantics in its profile. Names alone never establish identity; citations do not imply
support; different source statements are retained.

Initial inputs: scanned/born-digital PDF, HTML, Markdown/text, DOCX, PPTX,
XLSX/CSV/TSV, and native eCFR/JATS XML. Generic XML/JSON retains record paths;
domain interpretation requires a profile.

Ingestion stages are independent and resumable:

1. Inventory and fingerprint raw inputs.
2. Extract text, geometry, tables, captions, and native structure.
3. Establish stable addressable units by copying source text.
4. Propose vocabulary changes with examples, definitions, evidence, and enabled search tasks.
5. Extract mentions and typed relationships under an accepted profile.
6. Resolve identities with reversible decisions; review consequential merges/schema changes.
7. Verify source alignment and semantic judgments separately.
8. Publish immutable search artifacts and their derivation dependencies.

Faithful text/structural search can publish before optional enrichment. Record all
input, parser, prompt, model, profile, and correction hashes for invalidation.
Evaluate Docling against current extractors on identical golden documents. Evaluate
Docling Graph, LangExtract, and OntoCast behind the interchange contract; adoption
requires measured quality or implementation benefit, not a framework rewrite.

## Rust retrieval

Resolve explicit IDs, scoped terms, aliases, and user filters; obtain lexical,
semantic, and concept candidates; discover additional candidates via permitted
relations; fuse and rank; assemble necessary context; explain evidence and paths.

Initial traversal budget: top 20 seeds, two hops, at most 200 extra candidates.
Profiles permit relation directions/types. Scope and revision constraints apply at
every hop. Rank paths by seed relevance, type, and distance, not global popularity.
Required context includes definitions, conditions, exceptions, headers, footnotes,
and references. Completeness comes from traversal; budget truncation is explicit.

Keep Tantivy, ripgrep components, and local Model2Vec. Exact SIMD vector search is
the 100k reference. Approximate retrieval and heavier local reranking remain measured
experiments. Cache model/index handles within library/MCP sessions; memory-map
vectors and compact adjacency/posting indexes; avoid corpus-wide scans per query.

Interfaces remain seven verbs:

- `search`: relation mode off/explicit/verified, typed filters, relationship constraints, explanations.
- `refs`: profile-defined types, evidence, and traversal paths.
- `define`: scoped occurrences, aliases, missing text, and ambiguity.
- `read`: native evidence and addressable table/figure context.
- `map`: hierarchy and concept navigation.
- `status`: generation, enrichment/verification coverage, unresolved references, stale dependencies.

Hard filters are explicit. Ambiguous inferred query interpretations cannot silently
exclude documents. Results distinguish primary matches from supporting context.
The snapshot date defaults to ingestion date, never the furthest future effective date.

## Evaluation and release

Freeze source IDs, versions, hashes, and acquisition manifests for Fannie Mae plus
a second agency/lender guide, arXiv machine-learning papers, and PMC OA biomedical
papers. Use approved source access mechanisms and record redistribution licenses.

- 60 manually checked pages/structured regions for extraction.
- 100 tuning and 200 independent held-out tasks, evenly split between lending/research; research spans both disciplines.
- Real distractors to 100k units; synthetic mutation and 1m stress data reported separately.
- Cases: terminology mismatch, identity ambiguity, definitions, exceptions, citations, methods/datasets, tables, history, absence, and multi-document evidence.
- Compare body BM25, plain hybrid, repaired Sect, and individual added mechanisms using the same extracted content.

Gates: exact/structural/temporal invariants 100%; locate/definition R@5 >= .90 per
domain; accepted relation precision >= .95 with coverage reported separately;
relation-dependent supporting-evidence recall improves >= .10 absolute versus
relations off, with overall precision loss <= .02; no-answer accuracy >= .90.
At 100k units target warm p95 <= 500ms, cold CLI p95 <= 2s, query RSS <= 2GiB on a
documented workstation. Repeat fixed-agent runs three times, seeking >=30% fewer
tool calls without correctness regression. Report confidence intervals, cost,
latency breakdown, failed cases, and context size. Features missing gates remain
experimental. Never tune on the frozen held-out tasks.

Milestones: (0) baselines/docs/manifests, (1) reliable core and platform CI,
(2) general ingestion and both domains searchable, (3) connected search/context,
(4) 100k qualification and independent release evaluation. Milestone 1 can ship
independently; the generalized release requires milestones 2-4 in both domains.
