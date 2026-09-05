# Corpus creation harness and review milestone

Approved scope: preserve Sect's seven Rust search/navigation verbs and its portable
Markdown corpus. Improve how the corpus is created, grounded, verified, reviewed
and updated before the separate performance milestone. No claim of a universal
document store follows from passing integration tests.

## Deliverables and acceptance

1. Freeze 10 Fannie Mae sections, the existing FHA Update 18 handbook, 10 ML papers
   and 10 PMC OA biomedical papers. Preserve the original four frozen inputs. Expand
   through observed links and citations in identifier order; retain licenses, hashes,
   acquisition errors and parser artifacts. Generated format fixtures are engineering
   tests, not independent extraction qualification evidence.
2. Rust owns versioned document/region and identity contracts, JSON Schema and
   generated TypeScript. Preserve source regions, reading order, native locators,
   hierarchy, tables, captions, footnotes, exclusions and uncertainty. Search units
   reference source regions; search chunks never establish identity.
3. Stages have input, implementation and output hashes, immutable attempt artifacts
   and resumable completion receipts. An interrupted or failed document cannot make
   its unverified output searchable. Other documents continue. Publication uses the
   existing merge barrier and Rust immutable generations.
4. Identity automatically matches only a unique native identifier or unambiguous
   exact content. Existing addresses remain valid. New ambiguous revisions, splits,
   merges and retirements require source-bound human decisions and preserve history.
5. Keep the common ontology core and existing profiles. Source samples may propose
   versioned extensions with definitions, vocabulary, relation types, evidence and
   search examples. Humans approve schema changes and identity merges. Grounded
   concepts and document-centered relationships remain optional enrichment.
6. Answer-blind readers receive the same source window, profile and candidate set.
   Compare complete typed claims, endpoints, anchors, scope, qualifiers and evidence;
   check omissions in both directions. Record deterministic checks, model agreement
   and human adjudication separately. Agreement is not statistical independence.
7. Before every enrichment lot publishes, randomly sample by record type and format:
   20 records or the entire smaller lot. Any error holds the lot and tightens the next
   sample to 32. Five clean lots return to 20. Text can publish after extraction checks
   while optional enrichment is held.
8. Provide a loopback browser app and CLI over the same append-only review service:
   source evidence, hierarchy, concept/profile proposals, conflicts, identities,
   samples and independent blind benchmark judgments. Ten-item review batches;
   accept, reject, correct and defer. Receipts identify reviewer and exact bytes.
9. Enforce a campaign-wide $100 hosted-model cap across calls, retries and resumes.
   Reserve a conservative maximum transactionally before calls; reconcile actual
   provider charges. Unknown prices pause; ambiguous calls retain reservations.
   Pin resolved model identities and prices. No top-ups or silent model swaps.
10. Compare native extraction with pinned Docling and pilot Docling Graph and
    LangExtract behind adapters. Compare fidelity first, then structure/associations,
    then cost. Retain both outputs and uncertainties; do not replace parsers based on
    package reputation alone.

## Independent qualification

Prepare 60 extraction regions (30 lending, 15 ML, 15 biomedical) and 300 search
tasks (100 tuning, 200 held out; each split evenly lending/research, with both
research disciplines). The user supplies independent judgments. Proposed tasks and
machine-generated fixture labels are never human gold. Group task variants before
splitting; freeze parser/profile/prompt/ranking recipes before held-out judgments.

Compare body BM25, plain hybrid, Sect with relations off and Sect with verified
relations on identical extracted content. Preserve the existing gates: locate and
define R@5 >= .90 per domain; accepted relation precision >= .95 with coverage;
supporting-evidence recall gain >= .10; precision loss <= .02; no-answer accuracy
>= .90. Protected numbers, units, negation, conditions and table headers are checked
separately from structure coverage and indexing success. Missing human labels keep
quality unqualified. Existing scale failures independently block generalized release.

## Sources of implementation ideas

- [Docling document model](https://docling-project.github.io/docling/reference/docling_document/):
  source provenance, hierarchy, table/caption/footnote associations.
- [Docling Graph template workflow](https://docling-project.github.io/docling-graph/usage/cli/template-command/):
  evidence-backed schema proposals followed by deterministic validation/rendering.
- [LangExtract](https://github.com/google/langextract): span grounding and inspection
  of structured extraction, while retaining Sect's own interchange contract.
- [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties):
  explicit model identities and observed pricing instead of fallback price guesses.

## Review interface design

The primary concept uses a white workspace, teal selection/actions, a navigation
rail, a document queue, a source pane and a judgment inspector. Tokens: white
background, #064b50 accent, #292a35 text, #6c6d79 secondary text, #d7d9dc borders,
4px control radius; 14px UI text, 17px pane headings, serif document excerpts.
Desktop columns: 146 / 340 / flexible / 368px; 86px header and 56px footer.
Mobile stacks queue, evidence and judgment while retaining the navigation controls.

Required deviations from example concept copy: actual frozen source names and real
pending counts replace generated example documents; source locators vary by format;
review reasons are required; correction controls support the approved workflows.
All source text is inert. Page imagery is rendered from the original PDF, not the
generated design concept. No conceptual accuracy numbers are used as measurements.
