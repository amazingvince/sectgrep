# Implementation of the search reliability and generalization plan

This is an experimental implementation of the approved plan in `sect-search-vnext.md`.
It preserves the original product: local Rust search and navigation over a portable
corpus. Independent extraction, retrieval, relationship-quality, and scale gates
remain release requirements. The historical fixture scores are not those gates.

## What changed

- Index builds publish complete generations under `.sect/generations/`; a unique
  `.sect/published/*.ready` record selects a generation. Readers pin its source text,
  exact-search files, registries, graph, lexical index, vectors, and local model.
  An OS lock serializes builders; failed builds retain the previous generation.
- Freshness includes sidecars and registries. Changes to inherited navigation
  context invalidate dependent chunks. The incremental and full builds share the
  same source universe. Query sessions cache handles; new vector matrices support
  read-only memory mapping and exact top-k selection without sorting every vector.
- The selected revision supplies text, hierarchy, and metadata. Future revisions
  do not change the default snapshot date. Definitions have scoped occurrences,
  revision-aware usages, missing-text handling, and explicit ambiguity.
- Verification is bound to candidate bytes and cited raw/extraction dependencies.
  References compare anchors; Actions compare operation and target. Unique inferred
  candidates and missing verifier answers do not establish agreement. Merge restores
  touched corpus files after an index failure and commits only successful publication.
- Fidelity checks preserve numbers, decimal points, comparators and negation, check
  ordered source coverage and table associations, and replay derived Actions.
  Missing secondary OCR is held. Native extraction, source alignment, and semantic
  verification have separate states; an unchecked region is never described as verified.
- A Rust-owned knowledge schema generates JSON Schema and TypeScript types. Runtime
  checks reject malformed artifacts, conflicting identities/profiles, invalid locators,
  unknown revisions/anchors, out-of-scope mentions, and changed raw evidence hashes.
- Generic, lending, research, and eCFR profiles describe permitted vocabulary and
  relations. Accepted aliases introduce alternatives without silently merging identities.
  Relations can add search candidates, rather than only change existing candidates' scores.
  Traversal starts with 20 seeds, follows at most two hops, and adds at most 200 graph
  candidates; truncation is reported. Required context has a separate word budget.
- Native ingestion covers PDF, HTML, DOCX, Markdown/text, PPTX, XLSX/CSV/TSV, JSON,
  and XML. Raw files, parser artifacts, native locators, recipe hashes and derivations
  remain portable. Native headings use `context_kind: navigation`; authored summaries
  retain the summary checks. Changed same-date revisions and unreviewed OCR cannot
  silently publish. Unit topology changes require identity reconciliation.
- Knowledge proposals and explicit record-level reviews are separate harness stages.
  Proposal output cannot accept itself. Review decisions identify the reviewer, exact
  proposal hash and reason; the original proposal and decision receipt remain available.

## Try the new paths

Use Rust 1.92.0, Node 22 or later, and the repository's pinned pnpm version.
On Windows, use `target/release/sect.exe` in place of `target/release/sect`.

```sh
pnpm install --frozen-lockfile
pnpm -r build
cargo build --release --locked

node packages/sect-convert/dist/cli.js ingest-file \
  --input handbook.pdf --out corpora/demo --work work/demo \
  --source lending --id handbook --effective 2026-09-04 --profile lending
target/release/sect index corpora/demo
target/release/sect search "seasonal income documentation" --corpus corpora/demo \
  --relations verified --explain --json
target/release/sect refs DOC:lending:handbook --corpus corpora/demo --type references
target/release/sect map --concept '*' --corpus corpora/demo --json
target/release/sect status --corpus corpora/demo --json
```

`--effective` is the revision date supplied by the corpus owner. The generic adapter
does not infer section-specific effective dates inside a handbook. A document snapshot
must not be represented as a complete temporal policy model without that work.

For enrichment, adapt a parser/model's output to `docs/knowledge.schema.json`. Record
exact revision IDs, locators, quotes, raw hashes and profile-defined relationships.
Use distinct IDs for uncertain identities. Run:

```sh
node packages/sect-harness/dist/cli.js knowledge-propose \
  --candidate candidate.json --corpus corpora/demo --run staging/knowledge-demo
```

The command writes `proposal.json`, its dependency binding, and
`staging/knowledge-demo.decisions.json`. A reviewer fills the reviewer name, an
`accept`, `reject`, or `unchecked` decision per record, and reasons for decisions.
Leaving a record unchecked keeps it out of accepted retrieval. Then:

```sh
node packages/sect-harness/dist/cli.js knowledge-review \
  --run staging/knowledge-demo --decisions staging/knowledge-demo.decisions.json \
  --out corpora/demo/lending/reviewed.knowledge.json
target/release/sect index corpora/demo
```

This adapter boundary accepts proposals from other extraction/ontology projects.
It does not yet automate vocabulary discovery, identity reconciliation, or the
Docling/Docling Graph/LangExtract/OntoCast comparison campaign. No hosted model
was called for this implementation's tests or public-source smoke run.

## Reproduce acquisition and evaluation

`eval/corpora/sources.lock.json` records exact hashes, resolved URLs, acquisition
times, versions and license metadata for Fannie Mae, HUD FHA Handbook 4000.1 Update
18, arXiv 1706.03762v7, and PMC11558476. Raw documents are local ignored files.
The VA chapter URL originally considered now redirects to a general KnowVA page;
the downloader correctly rejected that HTML response as a PDF. HUD supplies the
second lending source. The handbook includes individual future effective dates,
which need separate temporal annotation.

PMC acquisition uses its [approved OAI-PMH API](https://pmc.ncbi.nlm.nih.gov/tools/oai/)
sequentially, with compressed responses. The public manuscript's rights metadata is
preserved; public access is not treated as a universal redistribution license.
The SheetJS dependency now uses the project's [official 0.20.3 distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).

```sh
python eval/acquire.py
node --max-old-space-size=8192 eval/ingest-smoke.mjs corpora/qualification-smoke-v2
target/release/sect index corpora/qualification-smoke-v2
python -m unittest discover -s eval -p test_qualification.py
python eval/qualification.py --binary target/release/sect \
  --corpus corpora/qualification-smoke-v2 --tasks eval/corpora/smoke-tasks.jsonl \
  --split smoke --repeats 3 --output review/public-smoke-evaluation.json
```

A changing source, including dynamic HTML, may not reproduce a frozen byte hash on
a later request. The downloader refuses to replace frozen inputs. Retain the acquired
raw files or create a separate acquisition snapshot; do not update held-out inputs in place.

The evaluation runner rejects duplicate IDs, cross-split query leakage, ambiguous
Work-only labels, contradictory no-answer labels, and filters that could override a
baseline. It records the binary/task hashes, generation, platform, per-query outputs,
process-cold CLI and warmed MCP timings, MCP peak resident memory, and bootstrap
confidence intervals. It checks that the corpus stayed unchanged during the run.

Baselines share extracted content: `--baseline body-bm25` uses the body field only;
`--baseline plain-hybrid` uses fielded BM25 plus the same local vectors without Sect
pins/signals/relations. The latter is not a separate body-only embedding model.
`sect`, `explicit`, and `verified` variants isolate relationship additions. Compare
additional extraction/context recipes in separate frozen corpora.

## Validation and remaining release work

The maintained regressions cover failed publication, pinned readers, sidecar and
registry edits, inherited-context invalidation, incremental/full equivalence, exact
grep parity, scoped definitions, future revisions, supporting context, knowledge
navigation, stale raw evidence, candidate tampering, Action kinds, anchors, decimal
and negation changes, table association, revision replacement and adapter locators.
CI is configured to run Rust and TypeScript builds/tests plus strict Rust formatting/lint on Windows
and Linux, and checks the generated contract. The Python prototype remains historical
research, outside the shipped runtime.

Measured on Windows 11 (build 26200), AMD Ryzen 9 7950X (16 cores/32 threads),
67,803,906,048 bytes of physical RAM, corpus on NTFS, Rust 1.92.0 release build:

| Check | Result |
|---|---|
| Windows Rust workspace | 55 tests passed |
| Linux Rust workspace, Ubuntu 24.04.4 under WSL2 | 55 tests passed |
| Real eCFR indexed/brute grep property | Passed separately on Windows, 1,225 seconds; omitted from the subsequent routine reruns |
| Windows TypeScript workspace | 104 tests passed: converter 50, harness 35, examples 19 |
| Python qualification runner | 7 tests passed |
| Rust formatting, strict Clippy, generated contract | Passed |
| Linux TypeScript and remote CI execution | Not run in this implementation session |

The test counts include regressions for multiple required anchors in the same section
and Action ancestry beyond twelve levels. The public ingestion used native extraction;
the scanned-document tests use injected transcribers. No live OCR/model campaign was run.

The public acquisition produced 10,496 indexed units (Fannie 11, FHA 10,438,
Attention 11, PMC 36), in a 14.2-second full index build with zero validation errors
or warnings. All warm MCP and cold CLI results matched. Three measured repetitions
per query, six smoke tasks, local model already cached, process-cold rather than
storage-cache-cold timings:

| Public corpus variant | Warm p95 | Cold CLI p95 |
|---|---:|---:|
| Body BM25 | 106 ms | 648 ms |
| Plain hybrid | 121 ms | 791 ms |
| Sect, relations off | 107 ms | 777 ms |
| Explicit relations | 110 ms | 729 ms |
| Verified relations | 110 ms | 721 ms |

Peak MCP resident memory across those variants was 434 MiB. Body BM25 found the
machine-authored expected section in three of five answerable smoke tasks; the
hybrid variants found all five, and all variants abstained on the one absence query.
There are no human-reviewed knowledge relations in this public smoke corpus, so
these results do not measure a knowledge-graph benefit or domain-level recall.

The 100k synthetic build contains 100,000 sections plus 1,001 containers. Its first
Windows build failed during Tantivy file creation with Access Denied. Full builds
now disable automatic segment merging during ingestion, explicitly merge and wait
for merge workers before publication; snapshot copying also runs in parallel.
The retry completed in 160.2 seconds with zero validation errors or warnings.
The exact OS cause of the initial file error was not established. The failed
unpublished generation remains available for inspection.

| 101,001-unit synthetic variant | Warm p95 | Cold CLI p95 |
|---|---:|---:|
| Body BM25 | 1,086 ms | 4,014 ms |
| Sect, relations off | 1,132 ms | 4,096 ms |
| Verified relations | 1,196 ms | 4,199 ms |

Peak MCP resident memory was 1,248 MiB. Three timing-only tasks, three repetitions
per task, with no relevance scores assigned. All CLI/MCP results matched. This
synthetic run **fails the 500 ms warm and 2 s cold targets**; it passes the 2 GiB
memory target. It is not a substitute for the real 100k qualification corpus.

A subsequent diagnostic measured 1,121 ms in the default freshness stat pass
alone (101,002 files and 101,002 directories); the full cold query took 4,426 ms.
`SECT_STAT_THREADS=32` reduced that stat pass to 740 ms; 64 threads took 766 ms.
Those single-query diagnostics do not change the benchmark's default settings.
Freshness checking needs a correctly invalidated change journal/watcher with a full
scan fallback. Cold loading also needs compact persisted structures and a stored
default-date projection. Disabling freshness checks would not satisfy the existing
behavior contract. These performance repairs remain outstanding.

The compact machine-readable record is
[`eval/results/implementation-2026-09-04.json`](../eval/results/implementation-2026-09-04.json).
Full per-query responses and raw build/test logs are retained locally under `review/`.
Reproduce the synthetic run separately:

```sh
python eval/gen_synthetic.py --sections 100000 --out corpora/qualification-synthetic-100k
target/release/sect index corpora/qualification-synthetic-100k
python eval/qualification.py --binary target/release/sect \
  --corpus corpora/qualification-synthetic-100k \
  --tasks eval/corpora/synthetic-tasks.jsonl --split smoke --repeats 3 \
  --variants sect verified body-bm25 --output review/synthetic-100k-evaluation.json
```

The following remain explicit work, rather than implied guarantees:

- Independent labels and extraction checks; real distractors to 100k units; 1m stress;
  accepted-relation quality/coverage; fixed-agent experiments; parser comparison.
- PDF reading order, table/figure/footnote association, XML mixed-content/attributes,
  and slide notes/graphics need golden-file qualification. The large FHA PDF produces
  many layout fragments with the current heading heuristic. Searchability alone does
  not establish good segmentation or completeness.
- Unit IDs use document keys and heading-derived section keys. Renames/deletions
  require explicit identity reconciliation; automatic stable mappings are not implemented.
- Traversal is bounded breadth-first discovery, not a globally optimal weighted-path
  solver. Compact persisted adjacency and eliminating all per-query corpus scans
  remain performance work, alongside the measured freshness and cold-load bottlenecks.
- Old and failed index generations are retained. Incremental builds copy the previous
  generation; disk reclamation and cheaper copy strategies need a reader-aware policy.
- Atomic publication covers ordinary process failures and cooperating writers. There
  is no durable cross-language merge recovery journal for a machine crash midway
  through source-file writes. Power-loss durability and manual external mutations of
  published generation files are outside the tested guarantee.
- The release gate deliberately remains false without independently checked evidence.
  `eval/qualification.py` reports missing gates rather than treating absent values as zero.
