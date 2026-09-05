# Corpus creation implementation and pilot

Implemented on September 4, 2026, against the decisions in [the creation plan](corpus-creation-plan.md). This is a working creation and review milestone. It does not establish generalized extraction or retrieval quality.

## Result

The final manifest is `eval/corpora/creation.review-pilot.json`. All 33 frozen sources prepared and published successfully to `corpora/corpus-creation-pilot-v2`. They contain 32,209 retained source regions, 11,057 addressable units and 33 document roots: 11,090 searchable works. The selected index is generation `01788574854563721700`, schema version 4.

The corpus includes ten Fannie Mae guideline sections, two supplemental navigation pages, the frozen FHA U18 handbook, ten ML papers and ten PMC OA biomedical articles. The original four-source qualification set remains intact. Acquisition hashes, licenses and source URLs are in `eval/corpora/creation.lock.json`; raw acquisition attempts and failures remain under `raw/corpus-creation`.

The active review run is `review/corpus-creation/review-pilot`. It has 362 pending items: 60 extraction checks (30 lending, 15 ML, 15 biomedical), two source-grounded profile proposals, and 300 machine-drafted, unjudged search tasks (100 tuning, 200 held out). The profile proposals came from the earlier hosted pilot, retain their original byte bindings and passed freshness checks before being copied into the review queue. None has been approved. No public review or benchmark judgment was fabricated.

## What changed

- Rust owns the document, region, table-cell, identity-ledger and knowledge contracts. JSON schemas generate the TypeScript interfaces. Source regions retain native locators, order, hierarchy, explicit table/header associations, captions, footnotes, exclusions and uncertainty. Search chunks remain separate.
- Native HTML extraction retains source DOM addresses and records excluded navigation. XML/JATS preserves hierarchy and explicit table/caption associations. Unknown PDF hierarchy and table headers remain uncertainty, rather than guessed truth. Text/Markdown, JSON, CSV/TSV and Office format support remains covered by fixtures.
- The pipeline records stage inputs, implementation hashes, output hashes and separate attempts. Completed stages are reused only when dependencies and outputs match. Failed documents are held independently. Compiled output is checked again before publication.
- Identity reconciliation preserves exact unique matches and requires review for ambiguous changes, splits, merges and retirements. An identical published revision reuses its recorded region-to-unit addresses, including repeated text. Rust rejects ledgers that differ from document revisions. Retirement hides current units while explicit historical reads remain available.
- Enrichment uses the same source windows and candidate addresses for separate model families. The verifier sees no proposer answers. Comparison includes typed endpoints, scope, qualifiers, locators, quotes and omissions in both directions. Repeated IDs cannot silently overwrite a different claim. Human corrections retain their own verification basis.
- Enrichment lots require a seeded, stratified sample of 20 or all records when smaller. Any sample error holds the lot; the next lot tightens to 32 and returns to 20 after five clean lots. Model agreement is not a human correctness label.
- The loopback review app and CLI share an append-only, hash-linked decision service. The UI includes ten-item batches, original PDF images with region overlays, structured source locations, independent source text browsing, profile/identity/claim review, and benchmark judgment forms. Held-out task, export and source access remain locked until tuning judgments, topic review and a recipe freeze exist.
- Legacy merge and the pipeline use the same publication barrier and recovery journal. Eligible documents publish together, allowing cross-document references in one generation. Corpus bytes are restored when indexing fails. One Windows Tantivy file-access failure occurred during the real pilot; the journal restored the corpus, and a retry succeeded. The underlying transient file-access cause was not established.
- The creation campaign has one SQLite budget ledger, reservations before requests, pinned catalog evidence, actual-charge receipts, retained ambiguous reservations and a hard $100 cap. Provider overruns pause subsequent spending. Truncated outputs can be repartitioned at complete region boundaries; no source region is silently cut. Unknown legacy model IDs no longer inherit another model's hardcoded prices: use the catalog-pinned pipeline or an explicit legacy model adapter.
- `sect read` exposes source-region metadata and identity history; `sect status` exposes creation coverage. The seven Rust verbs and CLI/MCP contracts remain intact.

## Comparisons and what they establish

`work/corpus-creation/parser-comparison-v2/comparison.json` covers the exact 60 regions in the final extraction sample. Docling 2.126.0 produced comparator artifacts for 45 PDF/HTML regions; native XML/JATS accounts for 15 unsupported comparator cases. Whitespace-normalized native text appeared in the Docling result in 27 of 45 comparisons. One comparison lacked at least one protected token. These are parser-agreement diagnostics: they do not identify which parser is correct. Source review must decide fidelity first, then structure/associations, then cost. Partial-page artifacts are retained for comparison and cannot be selected as complete document imports.

Pinned LangExtract 1.6.0 and Docling Graph 1.9.1 mechanism results are in `work/corpus-creation/mechanism-pilot`. On 20 exact source excerpts, LangExtract's aligned slice passed the independent exact-character check in 7 cases; all 20 explicit negative controls were rejected. Token alignment may expand a character excerpt to token boundaries, so the final exact-span check remains necessary. The Docling Graph template validated and rendered to syntactically valid Python; generated Python was not executed. This was a grounding/template mechanism pilot, not a comparison of end-to-end semantic extraction accuracy.

The hosted pilot used the pinned GLM and DeepSeek families. It produced two profile proposals, but no complete publishable relation lot. Attempts encountered malformed output, truncation and timeouts. Failed outputs and partition receipts remain available, and no resulting relation was promoted. Across 15 calls, reported charges are **$0.01291562186**, committed charges plus reservations **$0.03261829686**, and remaining authorization **$99.96738170314**. Three unresolved reservations remain charged against the cap; they were not assumed free. No model was swapped and no top-up was made.

Ideas adopted from primary sources: [Docling's document model](https://docling-project.github.io/docling/reference/docling_document/), [Docling Graph templates](https://docling-project.github.io/docling-graph/usage/cli/template-command/), [LangExtract span grounding](https://github.com/google/langextract), and [OpenRouter model pricing](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) and [reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). The catalog's supported reasoning levels were checked; the campaign retained `low` for its pinned models.

## Validation

Windows and native Linux checks passed: **57 Rust tests**, **126 TypeScript tests**, workspace builds, Rust formatting and Clippy with warnings denied. The previously validated expensive real-corpus n-gram test was deliberately excluded; this milestone did not change that algorithm. Eight Python evaluation tests pass. All six Rust-generated schema/interface artifacts regenerate identically after preserving existing line endings.

New checks cover stale stage outputs, interrupted writer recovery, shared budget reservations and overruns, immutable review receipts, source changes, held-out access, scope/qualifier disagreement, omissions, duplicate claims, retirement/history, identity-ledger consistency, real publication failure recovery, and an end-to-end healthy/failed document run. That run also tests stable review identities on resume and a human error holding subsequent publication.

`eval/results/corpus-creation-smoke-2026-09-04.json` contains three smoke queries across five retrieval variants: 15 runs with identical CLI/MCP results. They are explicitly timing-only tasks, with no relevance gold or retrieval-accuracy claim. Existing quality thresholds and known scale blockers remain unchanged.

Browser checks exercised validation errors, accept/reject/defer, persisted reloads, source rendering, batches and benchmark source navigation. Saved decisions used a separate synthetic fixture run. The final benchmark form exposes independent query, answerability, relevant revisions and supporting revisions without proposed answers. Desktop screenshots are in `review/ui-qa`.

The generated design concept and final 1536×1024 screenshot were inspected together. The implementation preserves the 146px navigation rail, 340px queue, flexible evidence pane, 368px judgment pane, 86px header and 56px footer; teal selection/action styling; source/structure tabs; the source highlight and serif excerpt; and the checklist/decision grouping. Necessary copy differences are real source names and counts, required review reasons, ten-item pagination, and actual native locator controls. Decorative settings/help buttons, an unimplemented run selector and shortcut hints were omitted. Responsive CSS is present, but the browser viewport override did not apply the requested 390px width; mobile visual qualification remains open rather than reported as passed.

## Use the implementation

From the repository root:

```powershell
pnpm -r build
node packages/sect-harness/dist/cli.js review --run review/corpus-creation/review-pilot --port 4178
node packages/sect-harness/dist/cli.js pipeline status --manifest eval/corpora/creation.review-pilot.json
node packages/sect-harness/dist/cli.js pipeline resume --manifest eval/corpora/creation.review-pilot.json
node packages/sect-harness/dist/cli.js pipeline publish --manifest eval/corpora/creation.review-pilot.json
```

The review server prints its session URL. Review data stays local. Export/import use the same decision service:

```powershell
node packages/sect-harness/dist/cli.js review --run review/corpus-creation/review-pilot --export decisions.json
node packages/sect-harness/dist/cli.js review --run review/corpus-creation/review-pilot --import decisions.json
```

An accepted profile can be exported with `review --run ... --profile-item ITEM_ID --out NEW_PROFILE.json`, then explicitly selected in the manifest. Enrichment remains off in the final review manifest; `creation.enrichment-v2.json` retains the hosted pilot configuration and its failure receipts.

After independently judging the 100 tuning tasks, export gold with `pipeline gold --manifest ... --split tuning --out tuning.jsonl`. Review topic overlap between whole-document families; provide a JSON attestation containing `reviewer`, `reason` and `no_topic_leakage:true`. Then use `pipeline freeze --manifest ... --recipes recipes.json --topic-review topic-review.json`. The freeze binds the actual parser, profile, prompt and ranking implementation as well as the supplied recipes. Held-out evaluation additionally requires `eval/qualification.py --freeze PATH`; changed bindings reject the evaluation. Export the 200 held-out judgments only after completing them.

## What remains open

1. Human extraction, ontology and benchmark judgments. The 300 tasks are machine-drafted starting points that must be rewritten/checked independently. Document-disjoint splits still need human topic-overlap review.
2. Provider reliability and extraction-output size on the pinned model pair. The small hosted pilot did not establish reliable automated semantic enrichment. The publication and verification paths are tested, but the public corpus currently has zero accepted concepts/relations.
3. Independent scan qualification and broader Office/layout fixtures. The public pilot has PDF, HTML and XML sources; generated conversions and existing Office fixtures do not prove arbitrary-format generality. PDF reading order, math, hierarchy and table associations require further source judgments.
4. Operational refinements: automatic application of extraction corrections, richer identity-editing controls, revocation of an already published bad snapshot, and an independently verified mobile layout. A review rejection holds a subsequent publication; it does not automatically retract a previously selected generation. Source repair or explicit release management is still needed.
5. The previously measured large-corpus latency/RSS failures. Source-region metadata is currently loaded with the index; it needs its own storage/performance work before making broad scale claims.

The next decision should be driven by the first extraction batches and the two profile proposals, then the 100 tuning judgments. They will show whether the highest-value improvement is parser fidelity, source organization, ontology vocabulary, or retrieval behavior. A graph rewrite or a claim of universal corpus support is not justified by the current evidence.
