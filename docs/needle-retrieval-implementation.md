# Needle retrieval: implemented first slice

2026-09-05. Implements the first source → section → passage → evidence slice of
[the approved plan](needle-retrieval-plan.md). Production corpus inputs were not
reingested. Experiments use isolated corpora and preserve the earlier generations.
Broad adoption still requires independent quality judgments. The
[real-corpus scale measurements](needle-scale-implementation.md) now pass the Windows
and Linux query latency/memory targets; large-corpus update costs remain a limitation.
Further implementations are recorded in [document storage](document-store-implementation.md),
[native source navigation](source-navigation-implementation.md) and
[local model comparisons](needle-model-experiments.md).
The [compiled-passage cache](compiled-passage-cache.md) now reuses unchanged document
groups during updates; graph/n-gram work and source snapshots remain corpus-wide.

## What changes for a caller

The FHA income-decline query now returns the TOTAL and Manual stability provisions
first and second, with their different paths and complete operative text. TOTAL
includes “downgrade and manually underwrite”; Manual includes the extenuating
circumstance, minimum 12 months, and reduced-income qualifications. Supporting
context includes the nearby definition and minimum-length provision where the
budget permits. Each quote identifies a pinned expression and exact canonical-body
byte range. The inspector displays the original PDF page alongside the evidence.

Search no longer relies on a 220-character best line as its primary response.
`search --legacy-snippets` retains that display during migration. Search JSON is
response version 2 and carries structured `evidence` even in compatibility mode.
`--evidence-budget 1500` bounds quoted primary, structural and graph context across
the response in **whitespace words**. It is deliberately named differently from
the measured model-token budget used to compile embedding inputs. Seed formatting
has its existing separate presentation budget. A partial section or omitted context
has continuation information; `read <hit.expr>` returns the canonical section.
`read <hit.chunk_id>` now expands the derived passage into its exact canonical
sections and preserves source spans and support. Passage addresses remain separate
from native paragraph anchors.

The seven verbs and offline query path remain. Document-backed passages can return
distinct parts of a long section. Legacy Markdown searches retain their one-hit-per-
section collapse behavior. Exact lexical postings still address each source member
when multiple small peers share one vector. Explicit filters apply to the selected
member, quoted peers, native dependencies, structural expansion and graph traversal.

## Repairs in the representation

- **PDF structure:** retain native outline levels; recover numbered levels when
  possible; protect body headings from repeated-header demotion; classify repeated
  page furniture and TOC entries; preserve editorial annotations as source content.
  Indentation alone no longer invents columns and reorders ordinary paragraphs.
  Single ambiguous Roman/alphabetic labels remain flagged. C/D and c/d are no longer
  mistaken for Roman hundreds in the manual grammar.
- **HTML:** select the article/main content while retaining original DOM paths and
  excluded regions. Fannie falls from 17 to 11 units; login/sidebar furniture is
  retained as excluded source material.
- **Tables and notes:** preserve explicit native header roles, header associations,
  row/column spans, captions and JATS footnote links. Table splitting keeps source
  rows in order and repeats known headers as separately quoted context. A tail-row
  regression test verifies headers, a native footnote, and the final exception.
- **Other formats:** JSON scalar pointers remain precise, while object records get
  separate coherent units. Empty records survive. Sheet boundaries and merged-cell
  geometry survive. Slides get separate organization boundaries. The later
  [source-navigation work](source-navigation-implementation.md) adds native DOCX
  mappings for unambiguous paragraphs and simple tables; complex constructs remain flagged.
- **Rust passage compiler:** deterministic paragraph/sentence/row boundaries,
  bounded fallback for oversized material, adjacent-peer assembly within a shared
  parent, original spans and source hashes, and recipe-bound passage IDs. Rechunking
  changes derived passages without changing source-unit identities.
- **Embedding integrity:** count the actual selected Model2Vec tokenizer, including
  the contextual prefix. Remove the wrapper's previous 1,024-token truncation.
  Indexing without an embedder explicitly reports word counts instead. Navigation
  containers remain addressable but do not consume ordinary lexical/vector slots.
- **Evidence and dates:** quote actual member text, preserve scope, use historical
  parents/reference targets for historical requests, and retain explicit continuation
  information. Fix the legacy snippet path that could display a filtered-out peer.

The compiler lives in `crates/sect-index/src/passages.rs` and `chunks.rs`; evidence
assembly is in `crates/sect-query/src/evidence.rs`. Source organization stays in
the shared converter, and the harness binds its structure recipe into cache keys.
The diagnostic inspector is opt-in and separate from blind benchmark review.

## Measured integrity and diagnostic results

Final native diagnostic generation: `01788588036204584800` in
`corpora/needle-retrieval-v5`. It contains six pinned real documents plus three
generated Office/JSON fixtures. The matched earlier representation uses the same
six raw revisions; source filters exclude synthetic fixtures from matched queries.

| Measure | Result |
| --- | ---: |
| Raw documents / bytes | 9 / 18,310,156 |
| Source regions | 29,406 |
| Canonical expressions, including navigation | 9,576 |
| Content passages | 3,777 |
| Separate navigation entries | 2,022 |
| Passages containing multiple source units | 2,226 |
| Median content passage body | 118 whitespace words |
| Content passages below 50 words | 670 (17.7%) |
| Maximum recounted model input | 796 tokens under the 800 ceiling |
| Source spans / supporting spans checked | 9,689 / 21 |
| Explicit oversized-boundary fallbacks | 2 |
| Uncovered canonical content / invalid quote spans | 0 / 0 |

The old six-document representation contains 10,530 chunks, median 40 words,
including generated navigation. This is a representation comparison, not a claim
that every old short chunk was wrong or that every new passage is semantically
complete. Recounting verifies the pinned canonical text; it does **not** prove that
a PDF parser transcribed the original page correctly.

[Integrity results](../eval/results/needle-retrieval-integrity-2026-09-05.json)
include the generation and mechanical checks. [Source-based diagnostics and
latency](../eval/results/needle-retrieval-validation-2026-09-05.json) retain before/
after responses, executable hashes, exact source quotes, and sample sizes. The
five asserted cases pass: both FHA scopes, the final spreadsheet row, the Word
retention rule, and a JSON record with its temperature and provisional status.

The baseline executable predates the earlier Rust performance optimizations as
well as these representation changes. Its timing difference therefore cannot be
attributed solely to this passage compiler. The new timing includes default
freshness scanning; the optional native notification shortcut is off. These are
small-corpus diagnostics with uncontrolled OS cache, not a real 100k qualification.

| Default Windows path | Earlier executable / original representation | Current executable / repaired representation |
| --- | ---: | ---: |
| Warm MCP p95, 20 samples | 71.5 ms | 52.7 ms |
| Process-cold CLI p95, 12 samples | 710.3 ms | 370.5 ms |
| Peak MCP working set | 454.2 MiB | 467.7 MiB |

The current timing corpus has the same six queried raw revisions plus three
synthetic fixtures, excluded by source filters. Freshness scanning still accounts
for the whole current corpus, so the workloads are not identical file counts.

### Passage policy comparison

| Target / ceiling in model tokens | Content passages | Median body words | Max observed input |
| --- | ---: | ---: | ---: |
| 256 / 256 | 6,299 | 94 | 256 |
| 512 / 800 | 3,777 | 118 | 796 |
| 1,024 / 1,024 | 3,627 | 116 | 1,024 |

All three preserve the same source-unit identity digest and retrieve both fixed FHA
clauses. These policies vary both target and ceiling. Their tiny diagnostic set
cannot select a universal optimum; scope constraints also mean that increasing the
ceiling does not monotonically increase median passage size. Keep 512/800 as an
experimental default. [Full policy results](../eval/results/needle-policy-ablation-2026-09-05.json).

### Parser comparison

Docling 2.126.0 was run on the full attention paper and FHA pages 254–256 using
the same raw bytes. The FHA page-255 protected phrases survive both parsers.
Docling improves reading order in the attention explanation and exposes four
tables and six equations. The comparison found and fixed an adapter bug: empty
normalized equation text was overriding nonempty `orig` text. Original equation
text and its PDF coordinates now survive, with mathematical-layout uncertainty.

This does not justify an automatic parser switch. Docling labels diagram text as
headings and ranks a caption above the explanatory section in the fixed query.
Its plain equation string still loses two-dimensional notation. Native PDF
extraction also misorders mathematical symbols in the attention paragraph. Both
require source inspection for mathematical interpretation. The separate
`corpora/needle-docling-attention` experiment is not the selected production parser.

A local, version-pinned GROBID capture adapter is provided. Its attempted run was
blocked by an unavailable local service; no GROBID quality claim is made. Docker
is not enabled in the WSL distribution. The adapter uses the documented local
[GROBID full-text API](https://grobid.readthedocs.io/en/latest/Grobid-service/) and
retains TEI coordinates, raw SHA-256 and service version.
[Parser evidence and decisions](../eval/results/needle-parser-comparison-2026-09-05.json).

## Reproduce and inspect

From the repository root in PowerShell, with the earlier pinned pilot available:

```powershell
pnpm build
cargo build --release --locked
node eval/needle-pilot.mjs corpora/needle-retrieval-v5
target/release/sect.exe --corpus corpora/needle-retrieval-v5 index --ngram off
cargo run --release -p sect-index --example passage_audit -- corpora/needle-retrieval-v5
python eval/needle-validation.py corpora/needle-retrieval-v5
node eval/needle-inspect.mjs corpora/needle-retrieval-v5 4179
```

The baseline must first be prepared with `python eval/needle-baseline.py` and
indexed with the preserved earlier executable. The script refuses to overwrite an
existing baseline. `needle-policy-ablation.py` makes isolated policy copies. Do not
benchmark concurrently with compilation, extraction or another benchmark.

The inspector prints a local session URL. Run the first failure query, select
TOTAL and Manual, and inspect PDF pages 255 and 334, the recovered paths, compiled
spans, returned context and source revision. Click the PDF to open it at full size.
Its old-result panel is explicitly the earlier 33-document diagnostic probe;
the matched six-source comparison is in the evaluation JSON. A new corpus
generation invalidates the inspector binding instead of mixing source versions.

The scripts create no relevance labels or review receipts. Original markup is
displayed as text. Word/spreadsheet source views currently show extracted regions
and locators, with an explicit notice that original Office rendering is unavailable.

## First-slice validation

- Rust: 65 tests passed on Windows, 64 on Linux; the extra Windows test exercises
  native file notifications. Real-corpus qualification tests were explicitly skipped.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- TypeScript: 135 existing/current suite tests plus the new Docling equation regression
  passed; all workspace packages build. The review UI had no preexisting unit tests.
- Browser: Chrome via Playwright; Browser plugin not available. Tested at 1600×1000
  and 390×844. Page identity, nonblank content, no framework overlay, console health,
  screenshot inspection and search/selection/repeat-search interactions passed.
  TOTAL opens page 255 and Manual opens page 334. Mobile panes stack vertically.
- Existing immutable-generation, failed-publication, incremental/full rebuild,
  exact/grep, selected-filter, retirement and future-revision tests remain green.
  The new tests cover peer pins, scoped compatibility snippets, bounded complete
  evidence, long-section tails, table headers/footnotes and recipe-preserved source IDs.
- The independent canonical-span/token recount also passes on both alternative
  passage policies and the separately converted Docling attention corpus. Eight
  Python evaluation-runner regression tests pass.

## Final implementation validation

The subsequent storage, source-navigation, compiler and query-loading changes have
their own bound experiments in the linked reports. After the final incremental-index
repair, the Rust suites pass **76 tests on Windows and 74 on Linux**, strict all-target
Clippy passes on both, and the TypeScript workspace builds with **145 tests passing**.
The separate Rust real-corpus qualification tests are explicitly skipped; real-scale
measurements come from the named runners below, not an inferred unit-test pass.

On 111,091 content passages from three pinned eCFR titles, the final Windows executable
records 461.5 ms warm p95 and 1,990.2 ms process-cold p95; Linux records 91.3 and
1,695.7 ms. Query RSS stays below 2 GiB on both. All 12 complete diagnostic result
objects, passage bytes and vectors match the original real-scale baseline across
both operating systems. [Final scale results and limits](needle-scale-implementation.md#final-executable-verification).
This preserves observed retrieval behavior through optimization; it does not replace
independent evidence-relevance labels. The Windows cold measurement is close to its gate.

## Remaining work and adoption gate

This is an inspectable first implementation, not a generalized-corpus qualification.
The next work needs source judgments independent of the implementation's own checks:

1. Review extraction and hierarchy across document families, especially mathematical
   notation, ambiguous outline labels and multi-column pages. Use the existing blind
   review workflow; do not derive held-out labels from these diagnostic rankings.
2. Label primary and required supporting source spans. Measure per-domain Recall@5,
   nDCG, precision, required-context coverage and tool calls at fixed context budgets.
   Existing qualification requires 50 tuning and 100 held-out tasks per domain and
   at least 60 manually checked extraction regions; these remain unjudged.
3. Continue from the [contextual embedding and reranker comparison](needle-model-experiments.md)
   with independent source judgments and an integrated retrieval evaluation. The
   default remains static Model2Vec; seven diagnostic queries do not justify a switch.
   The context assembler uses structural and native relationships; it does not prove
   that every condition or exception elsewhere in a document was discovered.
4. Continue from the [document-store implementation](document-store-implementation.md):
   opt-in bundles and mapped section reads now remove authoritative per-section files.
   Derived text deduplication remains. A [document compilation cache](compiled-passage-cache.md)
   now skips unchanged passage groups. Unique Word
   paragraphs now have native mappings; complex Office constructs, spreadsheet header discovery, ambiguous native-note span
   matching and source-normalization maps need further work. Unknown spreadsheet
   headers are explicitly flagged; the first row is not automatically semantic truth.
5. Continue from the [real-corpus scale measurement](needle-scale-implementation.md).
   On 111,091 real regulatory content passages, Windows passes at 462 ms warm p95 /
   1,990 ms cold p95 and Linux at 91 / 1,696 ms; both use less than 2 GiB query RSS.
   Artifacts and all 12 query results match across platforms. Automatic updates on
   the large Windows corpus still take about 4.3–4.5 minutes in the final mutation run;
   Linux takes 56–72 seconds. Rebuild RSS reaches 6.64 GB on Windows and 9.35 GB on Linux.
   The [subsequent compilation cache](compiled-passage-cache.md) addresses passage reuse;
   incremental graph/n-gram work remains. Same-size edits
   with restored timestamps evade the metadata scan and require a full rebuild.
   This legacy XML workload does not qualify every format or the document-bundle mode.

The evidence so far supports the representation change and fixes the demonstrated
failure. It does not support a universal parser, a universal passage size, a complete
ontology, or a claim that broad independent retrieval targets have passed.
