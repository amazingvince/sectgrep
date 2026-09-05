# Measuring a real large corpus

Measurements completed on 2026-09-05. The final executables pass the query latency
and memory targets on both operating systems over 111,091 real content passages.
Large-corpus updates remain expensive. This is a scale workload, not a relevance
benchmark; no labels or review receipts are manufactured by these scripts.
The subsequent [compiled-passage cache](compiled-passage-cache.md) records the next
update optimization and its separate measurements; the timings below bind earlier executables.

## Fixed source selection

The workload contains complete eCFR Titles 21, 26 and 40 from
[GPO's bulk XML service](https://www.govinfo.gov/developers). The titles were selected
before conversion or timing, and no source was duplicated. Raw bytes and acquisition
metadata are pinned in [the source lock](../eval/corpora/needle-scale.lock.json).
The existing native eCFR converter supplies the canonical Markdown hierarchy.

| Title | Source XML bytes | Native sections | XML paragraphs | XML tables | Canonical nodes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 21 | 21,695,580 | 8,408 | 67,615 | 568 | 9,751 |
| 26 | 88,045,074 | 6,156 | 166,133 | 2,794 | 6,573 |
| 40 | 161,191,208 | 24,650 | 370,900 | 9,567 | 28,996 |

XML division counts include volume wrappers; canonical nodes include navigation.
Neither is a content-passage count. The benchmark counts non-navigation passages
after indexing and reports distinct body hashes and very short passages separately.
Conversion took approximately 6.3, 9.2 and 29.9 seconds respectively. The largest
conversion process reached 4,013,408 KiB peak RSS. These are local ingestion
measurements, separate from Rust query memory and latency.

This workload uses the legacy native-XML-to-Markdown path, not the newer document
bundle path. The first conversion emitted 45,320 canonical nodes but retained only
45,318 Markdown files (251,983,734 bytes) on Windows. The collision repair below
requires a fresh conversion; the original corpus is preserved as failure evidence.
Those first corpora use the converter's existing XML amendment-date fallbacks.
The corrected v3 workload uses recorded acquisition-day snapshot dates, as explained
below. Per-section dates were not fetched; this experiment does not establish
historical accuracy or native document-artifact region coverage. Complete raw titles
do not imply complete extraction: the legacy adapter recognizes sections and their
container levels but currently omits native `APPENDIX` divisions (1,336 in Title 40).
This gap must remain visible when interpreting the workload.

## Reproduce

```powershell
python eval/needle-scale-acquire.py
pnpm build
node eval/needle-scale-prepare.mjs corpora/needle-scale-real-v3
target/release/sect.exe index corpora/needle-scale-real-v3 --validate-only --json
python eval/needle-scale-index.py --binary target/release/sect.exe --corpus corpora/needle-scale-real-v3 --logs review/needle-retrieval/scale-parallel-windows
python eval/needle-scale-validation.py --binary target/release/sect.exe --corpus corpora/needle-scale-real-v3 --output eval/results/needle-scale-windows.json
```

Acquisition verifies an existing lock rather than replacing it. Preparation refuses
an existing corpus destination. Preserve previous outputs and choose new paths for
another run. Run benchmarking serially after indexing, without compilation,
conversion or another benchmark competing for resources.

The benchmark uses 12 fixed queries, five warm repetitions and two process-cold
repetitions per query. It checks full result equality between warm MCP and CLI,
freshness, immutable generation hashes and source hashes. Default freshness is
enabled; the experimental notification shortcut is rejected. Process-cold includes
startup, with an uncontrolled OS page cache. Targets are 500 ms warm p95, 2 seconds
process-cold p95 and less than 2 GiB peak MCP RSS on at least 100k real content
passages. Windows and native Linux filesystems must be measured separately.

The initial Windows executable has SHA-256
`680eaa101d76f36a93a860d8128a800df44a842608bdf839c4fdcfacd2b3e138`.
The initial build was stopped after 954.6 seconds without publishing a generation,
at an observed peak of 2,838,126,592 bytes RSS. This is an interrupted-run lower
bound, not a completed build time or a query memory measurement.
[The interruption record](../eval/results/needle-scale-initial-build-2026-09-05.json)
preserves the executable binding. The executable itself is retained locally as
`review/needle-retrieval/sect-pre-scale.exe`.

## Bounded tokenizer work

The previous splitter encoded the entire remaining section before every passage
and binary-searched character offsets across that same suffix. Long sections
therefore incurred repeated tokenization proportional to their remaining length.
The revised splitter grows a local byte window until its actual token count exceeds
the budget or it reaches the source end, then finds the fitting prefix inside that
window. Eight bytes per token is only the initial probe size; it neither estimates
the final token count nor caps source content. All final passages are recounted.

The passage recipe changes to `coherent-passages-v4` because a tokenizer's
non-monotonic prefix counts can produce different valid boundaries under a different
search bracket. Canonical source identities remain unchanged; derived passage
addresses and indexes must be rebuilt. The old recipe remains readable through its
pinned generation. The Windows and Linux regression suites pass (69 and 68 tests),
strict Clippy passes, and all 143 TypeScript tests pass. Real-corpus qualification
tests were excluded from those short Rust suites.

An isolated packed pilot rebuild retains 3,777 content passages and 2,022 navigation
entries. Its [independent mechanical audit](../eval/results/needle-window-integrity-2026-09-05.json)
checks all 9,689 source spans, 21 support spans and actual model token counts, with
a maximum of 796. All [fixed retrieval probes](../eval/results/needle-window-validation-2026-09-05.json)
pass. The new small pilot has 17.1 ms warm p95 and 342.9 ms process-cold p95; this is
not an isolated splitter-speed comparison or a large-corpus qualification.

The revised Windows executable has SHA-256
`1c9ff4774d5d7f6b9e41bb74ad226815cdc4154b52fe9764e1fccadec3bc142d`.
The [second large build](../eval/results/needle-scale-window-build-2026-09-05.json)
was stopped after 328.1 seconds. An earlier inference that it was still loading
sources was incorrect: shell redirection delayed delivery of timing records.
Directly streamed logs show source loading in about 17 seconds and tree/graph
construction in about 12 seconds; the sustained work follows those stages in
passage compilation. Six separately parsed large or definition-heavy sections take
6–121 ms each. Optional phase timings and `sect-corpus`'s `parsebench` example now
separate parsing from file discovery and directory work. Use `needle-scale-index.py`
for direct native logs and process measurements. The full-build bottleneck is still
under investigation. No scale gate has passed; mutation/freshness validation also
remains to be run at this size.

The subsequent direct-log serial run was stopped after 370.9 seconds; compilation
still had not completed, at 2,589,085,696 bytes sampled peak RSS. Its executable is
preserved as `review/needle-retrieval/sect-serial-passages.exe` (SHA-256
`4566b265922e9716a7b0d025c59c2ac8f3bdbdd67ed98dc531eb463fba614cb9`).
Canonical files compile independently, so the next change uses indexed Rayon
parallel collection and flattens results in the original source order. Error
selection remains in source order too. The serial and parallel v4 compilers produce
byte-identical chunks, vectors, source-region maps and canonical section storage
on the same packed pilot. [The parity record](../eval/results/needle-parallel-parity-2026-09-05.json)
binds both generations and artifact hashes. No numerical speedup is claimed from
these interrupted runs.

## Source path collisions and early validation

Title 40 contains distinct Subparts `Cc` and `CC`, and `AAa` and `AAA`. The old
converter used their labels as directory and file names. Windows overwrote one
parent file in each pair, losing source text and breaking descendant parent links.
Path mapping now examines the complete output tree and adds deterministic case-based
hash suffixes to ambiguous components, including directories. Noncolliding paths,
semantic IDs, native locators and parent IDs retain their meanings. The same mapping
is emitted on Windows and Linux. This addresses case distinctions; it does not claim
to handle every possible filesystem naming restriction.

The preparation script now rejects duplicate folded paths, duplicate canonical IDs,
unresolved parents or a node/output count mismatch before writing. It uses exclusive
file creation and reads every output back. A regression writes the four subparts and
their descendants to a real temporary directory, verifies all text, and checks
source identities and parent paths.

The legacy converter also now marks generated-only tables of contents as navigation.
Structural nodes with their own source text remain ordinary content. Full canonical
listings remain available to exact search and navigation; generated listings do not
inflate the real content-passage benchmark.

Rust now returns corpus contract errors before tree/graph construction, passage
compilation and model loading. A regression supplies an unresolved parent and an
explicitly local, incomplete model: it gets the validation report, compiles zero
passages and leaves the previous generation readable. The regression suites pass
on Windows and Linux (70 and 69 tests), strict Clippy passes, and all 145 TypeScript
tests pass. The fresh v2 conversion retained all 45,320 emitted canonical nodes,
including 5,984 generated-only navigation nodes. Every output was read back and all
parent IDs resolve. Its Rust validation then stopped with 63 temporal errors in
37.8 seconds, compiling zero passages and publishing nothing.

All 63 errors concern cross-title references: the first-volume amendment-date
fallback makes an entire title appear older than the available revision of another
title. Title 40 alone has 37 volumes with different `AMDDATE` values; a single first
value is not a trustworthy whole-title or per-section effective date. The temporal
validator remains unchanged. Isolated v3 uses the source lock's actual common
observation day, 2026-09-05, to identify each captured snapshot. This is an observation
date, **not a legal commencement date**. The preparation script requires that all
three acquisition receipts have the same observation day. A historical corpus needs
per-section version history and explicit date semantics; this benchmark supplies
neither. The failed v2 corpus and report remain preserved.

## Completed compilation and lexical publication failure

The v3 Windows run completed passage compilation and saved 117,066 entries:
111,082 content passages, 108,311 distinct content bodies and 5,984 navigation
entries. It recorded a maximum of 800 model tokens; 5,397 content passages have fewer
than 20 whitespace words. These are compiler-output counts, not independent source
or relevance judgments. [The failed-build inventory](../eval/results/needle-scale-compilation-v4-2026-09-05.json)
binds the executable, saved chunk bytes and run measurements.

Source loading took 18.2 seconds, validation 3.9 seconds, the structural stage
including model preparation and passage compilation 291.9 seconds, and structural
publication writes 20.8 seconds. The run failed after 346.4 seconds while replacing
Tantivy metadata. Sampled peak build RSS was 5,248,147,456 bytes; this is not query
RSS. No ready marker was published, so the partial generation is not searchable.

The saved artifacts expose substantial amplification: `chunks.jsonl` is 909 MB,
`terms.json` 756 MB and `tree.json` 199 MB. Chunk field values alone repeat 289 MB of
context and 222 MB of model input around 186 MB of body text. This remains a storage
and memory concern; source-span addressing alone does not eliminate duplicated text.

## Windows metadata replacement

The isolated lexical example reproduced the failure without repeating conversion
or passage compilation. A directory adapter identified the actual failed operation
as atomic replacement of `.managed.json`; Tantivy had wrapped that error with the
name of a segment being registered. The process holding or interfering with the
file was not identified. Windows sharing rules can prevent replacement while a
reader has not shared delete access, which also governs rename operations.
[Microsoft documents those sharing rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

The adapter now retries only Windows error codes 5 and 32 during atomic replacement,
with at most 254 ms of cumulative waits. It retains atomic replacement and reports
persistent errors instead of truncating old metadata. Segment creation, permissions,
locks and generation publication retain their existing behavior. A native regression
holds a reader without delete sharing, verifies recovery after its release, then
holds the lock through the retry budget and verifies that failure preserves old bytes.

Two isolated builds of all 117,066 diagnostic records now complete in 12.8 and
12.7 seconds. Those examples include navigation records and are writer diagnostics,
not normal retrieval indexes. The subsequent full pipeline also succeeds and logs
three metadata replacements recovering after one retry each. This supports the
bounded recovery mechanism without identifying the original interfering process.

## Token-offset boundary proposals

The current compiler recipe is `coherent-passages-v5`. It uses the tokenizer's original
byte offsets to propose a fitting prefix in one encoding, then independently
recounts that prefix. If normalization or subword behavior makes the proposal
oversized, the prior bounded search remains the fallback. Every final passage is
still recounted and source addresses remain unchanged. Derived passage identities
change with the recipe; previous generations remain readable.

A tokenizer-backed regression covers combining marks, CJK, ligatures and a single
Arabic source character whose normalization expands into several words. It proves
that an oversized offset proposal is rejected, all source bytes survive and every
returned input stays within the budget. The full suites pass: 72 Rust tests on
Windows, 70 on Linux, strict all-target Clippy and 145 TypeScript tests. Eight Python
qualification-runner tests pass after making the MCP client timeout configurable
for long automatic rebuilds; the default timeout remains unchanged.

The [new pilot audit](../eval/results/needle-offset-integrity-2026-09-05.json) verifies
all 9,689 primary spans and 21 support spans, with 796 maximum recounted tokens.
Its 3,777 content passages, 2,022 navigation entries, 118-word median and 670 content
passages below 50 words are unchanged. All [fixed retrieval probes](../eval/results/needle-offset-validation-2026-09-05.json)
pass. Small-pilot warm p95 is 16.7 ms, process-cold p95 347.8 ms and peak MCP RSS
484,499,456 bytes; these remain diagnostic measurements on nine documents.

## First published real scale generation

Windows generation `01788604534427662200` published successfully with executable
SHA-256 `c9bae7f648eaed973228a92420eb09fdef79aeab1cdb8157a1cd2fe32e03a599`.
Native process time was 297.4 seconds; the internal stage report accounts for 292.2
seconds. Sampled peak build RSS was 5,224,505,344 bytes.

| Stage | Milliseconds |
| --- | ---: |
| Source loading and fingerprints | 31,967 |
| Contract validation | 3,220 |
| Structural layers, model preparation and passage compilation | 128,728 |
| Structural artifact writes | 20,596 |
| Lexical indexing | 14,378 |
| Semantic indexing | 70,847 |
| N-gram indexing | 21,526 |
| Cache writes | 887 |

The structural stage decreased from 291.9 to 128.7 seconds on the same inputs and
token policy. This is a single-run stage comparison; the earlier whole build failed
before semantic indexing, so it cannot supply a completed end-to-end baseline.

The [independent mechanical audit](../eval/results/needle-scale-integrity-2026-09-05.json)
passes all 117,075 primary span checks, 6,550 support span checks and actual token
recounts. The maximum is 800 tokens. There are 111,091 content passages and 5,984
navigation entries, with 108,320 distinct content bodies. Content has a 305-word
median; 13,491 entries have fewer than 50 words. These sizes reflect source structure
under the same policy rather than a requirement to make every passage equally long.

This audit validates quotes against canonical Markdown. The legacy XML path has no
native document-artifact region map, so its raw-document/region counters are zero.
The acquisition script separately verifies all three original XML hashes. Neither
check establishes complete XML extraction or independent relevance.

## Shared term usages and bounded artifact reads

The [first Windows query measurement](../eval/results/needle-scale-windows-2026-09-05.json.gz)
passed the warm target at 468.4 ms p95 but failed process-cold latency (3,975.2 ms)
and peak query memory (3,611,791,360 bytes). All 12 query results were stable across
60 warm MCP and 24 process-cold CLI samples with default freshness enabled.

The graph previously copied each term's complete occurrence list into every matching
definition. The new `shared-term-usages-v1` representation stores each list once,
retaining the definition-specific exclusion of its own Work as a logical view.
Legacy generations remain readable. Codec changes invalidate freshness, and migration
preserves source identities, passage recipes and vector inputs. JSONL reads and writes
now use bounded buffers instead of retaining whole serialized files in temporary strings.

The [real-corpus migration comparison](../eval/results/needle-shared-terms-scale-parity-2026-09-05.json)
checks all 241,493 relationships, 8,817 tables, 17,536 definitions and 6,592,891
logical term usages. Every view matches. Chunks, vectors, tree and region artifacts
are byte-identical between generations `01788604534427662200` and
`01788607189517248200`. Term storage decreased from 756,196,789 to 82,746,340 bytes.
The migration took 190.7 seconds and reached 5,657,710,592 bytes sampled build RSS;
it still recompiles passages despite unchanged source content, so this is not a
claim that incremental rebuild cost has been solved.

The [second Windows measurement](../eval/results/needle-scale-shared-terms-windows-2026-09-05.json.gz)
uses executable SHA-256 `8b080fce559934cc86a41e2337a5dc37c4785976422757d793c095d9f94fb66a`.
All 12 complete search result objects also match the earlier executable's results.
Warm p95 is 446.1 ms, process-cold p95 2,914.7 ms and peak query RSS 2,439,729,152 bytes.
Cold latency and memory still fail their targets at this step.

Before the query projection change, 73 Rust tests passed on Windows and 71 on Linux,
along with strict all-target Clippy, 145 TypeScript tests and eight Python runner tests.
The extra Windows tests cover notification invalidation and atomic replacement sharing.

## Query projection and load costs

Search now deserializes a separate in-memory view of the existing immutable passage
records. It retains bodies, source spans, support, ranking metadata and recipe IDs.
Index-only context, citation postings and model-input strings stay on disk. The
complete `Index::chunks` view remains available to builders and audits. Older
passages without source spans read their exact original model-input field from the
selected record when confidence calculation needs it. Record offsets include UTF-8
bytes and blank lines, and the fallback checks the selected passage identity.

The [projection-only Windows measurement](../eval/results/needle-scale-query-projection-windows-2026-09-05.json.gz)
uses SHA-256 `3152b8201858cd27adc2de29f543a06f412f57bf2f53203539691bb53732142f`.
All 12 complete results match the original scale baseline; no generation is rewritten.
Warm p95 is 455.4 ms, process-cold p95 2,721.6 ms and peak query RSS 1,805,320,192 bytes.
Warm latency and memory now pass. Cold latency remains above two seconds.

An instrumented load attributes 1,567.8 ms to opening/freshness, 860.8 ms to the query
projection, 92.2 ms to the model and 11.6 ms to lexical/vector handles. Loading the
tree and graph concurrently and parsing small structural JSON files from bounded
byte buffers reduces the open stage to 1,055.3 ms in a subsequent diagnostic.
Those stage timings are single-run diagnostics, not p95 query measurements.
The next loader parses small batches of independent passage records concurrently,
preserving file order, byte offsets and error order. The
[batched-load measurement](../eval/results/needle-scale-batched-query-windows-2026-09-05.json.gz)
records 449.3 ms warm p95, 2,115.7 ms process-cold p95 and 1,857,519,616 bytes peak
query RSS. It still misses the cold target. The current continuation moves complete
UTF-8 validation to the parsing workers and loads the required model alongside the
passage view. FTS-only queries still avoid semantic resources. Thresholds are unchanged.

The [final Windows load measurement](../eval/results/needle-scale-parallel-query-windows-2026-09-05.json.gz)
uses executable SHA-256 `dbc0e9aed8ccb4bd644b36b34a145c8bcbe2c6af57644c00e1197c1d5a631766`
against the same generation `01788607189517248200`. All 12 complete result objects
match the original scale baseline. Across 60 warm and 24 process-cold samples,
warm p95 is **449.5 ms**, cold p95 **1,882.1 ms**, and peak MCP RSS **1,860,034,560
bytes**. All three Windows scale targets pass. OS page-cache state remains uncontrolled;
this measures process-cold startup, not a reboot or storage-cold workload.

| Windows stage | Warm p95 ms | Process-cold p95 ms | Peak query RSS bytes |
| --- | ---: | ---: | ---: |
| Original scale baseline | 468.4 | 3,975.2 | 3,611,791,360 |
| Shared term lists and streaming reads | 446.1 | 2,914.7 | 2,439,729,152 |
| Query projection | 455.4 | 2,721.6 | 1,805,320,192 |
| Parallel structural and batched passage loads | 449.3 | 2,115.7 | 1,857,519,616 |
| Parallel model loading and UTF-8 validation | 449.5 | 1,882.1 | 1,860,034,560 |

Each row is a separate run over the same 12 fixed queries. These are mechanism
comparisons with preserved answers, not confidence intervals or relevance judgments.
The retained model, passage contents, source revisions and default freshness policy
are unchanged. Native Linux inputs now contain all 45,320 canonical files and the
three verified raw XMLs.

## Native Linux build and query measurement

Linux generation `01788609940647967689` uses executable SHA-256
`5fb8bf65202fbd8267d5f5a2473930fdee9dbe9b1642ade6c0f4aa0bfbc4d187` on native WSL2
Linux storage. Its full build took 88.2 seconds and reached 4,019,761,152 bytes sampled
peak RSS. Its internal stages were 9,982 ms input loading, 2,771 ms validation,
29,839 ms structure/model/passage compilation, 4,295 ms structural writes, 12,691 ms
lexical indexing, 17,222 ms semantic indexing, 9,677 ms n-grams and 692 ms cache writes.
This is a separate platform build measurement, not a controlled allocator comparison.

The [cross-platform artifact comparison](../eval/results/needle-scale-windows-linux-parity-2026-09-05.json)
verifies identical passages, vectors, document tree and region files, plus identical
graph views for all relationships, tables, definitions and logical term usages.
All 12 full result objects also agree across the two operating systems.

The [Linux query measurement](../eval/results/needle-scale-parallel-query-linux-2026-09-05.json.gz)
passes all targets: **89.9 ms warm p95**, **1,577.8 ms process-cold p95** and
**1,846,820,864 bytes peak MCP RSS**. It has the same 60 warm and 24 process-cold
samples and default metadata freshness as Windows. The Windows and Linux query gates
now pass; ordinary mutation costs remain a separate measurement.

## Incremental update costs

The [first Windows mutation diagnostic](../eval/results/needle-scale-mutation-windows-2026-09-05.json)
returned the correct text after creation (263.1 seconds), a same-size edit (387.3
seconds) and deletion (416.8 seconds). All three rebuild logs reported `full` even
though the only changed file was an unrelated plain-text probe.
The default metadata scan detected these ordinary changes; the subsequent work was
too broad. These timings include rebuilding and reopening the index, and are not
ordinary query latency. Canonical answers, passages and vectors stayed unchanged,
as did the raw sources and the pinned original generation. Peak MCP RSS including
rebuilds reached 6,687,342,592 bytes; this does not describe an unchanged-input query.

The code had two coupled causes: any non-Markdown change discarded all parsed documents,
and an empty parse cache forced full lexical/vector replacement. In addition, merely
reparsing a document marked its unchanged compiled passages for replacement. The repair
restricts global Markdown parse invalidation to source registries, derives
layer replacement from actual compiled differences, and retains full recovery when
the previous passage inventory is missing or corrupt. Regressions now pass: 75 Rust
tests on Windows and 73 on Linux, with strict Clippy on both. They cover unchanged
passages under sidecar edits, missing parse caches, removal bookkeeping, corrupt
inventory recovery and registry changes affecting searchable fields.

The [repaired Windows mutation run](../eval/results/needle-scale-mutation-invalidation-windows-2026-09-05.json)
uses executable `21fb0304bfee2c9f5589417b7b9fd432c4c356781e2f051226b76edd8d299b03`.
Create/edit/delete complete in 221.4, 252.3 and 236.7 seconds, with incremental
updates and all correctness/immutability checks passing. Creation's logged lexical
and semantic stages decrease to 648 and 421 ms, respectively, but passage compilation
still processes the corpus (152.7 seconds for the structural stage). The deletion
log similarly records 734 ms lexical, 550 ms semantic and 161.4 seconds structural.

Peak rebuild RSS in that run rose to 7,218,786,304 bytes. The reused parse cache retained
old parsed documents alongside current copies. The lifetime repair releases those
old copies after collecting current documents; the prior compiled inventory supplies
removal identities. The [final Windows mutation run](../eval/results/needle-scale-mutation-final-windows-2026-09-05.json)
uses executable `b4ab2f7902ffa1b3a93bf4c148e27a825eb7035587bc40eb2d434044bd77ef02`.
Create/edit/delete pass in 258.5, 261.6 and 271.6 seconds, with all source, answer,
passage, vector and immutable-generation checks passing. Peak MCP RSS is
**6,642,266,112 bytes**. The shorter object lifetime removes unnecessary overlap;
these separate runs do not establish a causal memory reduction or a speedup.
The [final Linux mutation run](../eval/results/needle-scale-mutation-linux-2026-09-05.json)
passes create/edit/delete in 72.2, 57.3 and 56.1 seconds using executable
`03558c1c6178307753e5cb7addd71b778b40c749b328065cb9829510b30cc2b7`.
Canonical answers, raw inputs, old generations, passages and vectors remain unchanged.
Peak MCP RSS including successive rebuilds is **9,350,156,288 bytes**. Releasing the
old parse objects does not establish a small resident working set; retained query
state, new/previous compilation data and allocation behavior still require profiling.
This is separate from the less-than-2-GiB query measurements. Source-specific compiled caches and
incremental structural/n-gram work remain necessary for interactive large-corpus updates.

The query-loader regression spans 519 Unicode records across multiple batches, with blank
lines, exact legacy model-input reads, record-order assertions, identity mismatch
rejection and invalid UTF-8 in an otherwise ignored indexing field. The Windows
suite at that stage passed 74 tests and Linux 72, with strict Clippy on both. Separate real-corpus
qualification tests are skipped in these Rust runs; the named scale runners provide
the real workload measurements.

### Metadata-only edits retain lexical postings

The final indexing regression changes only a section's review confidence from `1`
to `0.99`. This reparses the Markdown without changing its compiled passages. A
retained removal path deleted the section's lexical postings even though the new
compiled-passage comparison correctly found nothing to replace. The new test first
failed on a search for `quasar` while confirming identical passage bytes.

The repair removes the redundant parse-based removal list. Both additions and
removals now derive from the same old/current compiled-passage comparison, including
deleted expressions and members of merged passages. Missing or corrupt previous
inventories still force a complete layer rebuild. The regression now passes; the
final Rust suites pass **76 tests on Windows and 74 on Linux**, with strict all-target
Clippy on both. Logs are preserved under `review/needle-retrieval/metadata-postings-*`.
This targeted edit differs from the whole-corpus plain-text mutation workload above.
The final TypeScript workspace build and all 145 tests also pass, recorded in
`review/needle-retrieval/final-typescript-{build,tests}.log`.

## Metadata-preserving edits

The isolated [Windows](../eval/results/needle-metadata-freshness-windows-2026-09-05.json)
and [Linux](../eval/results/needle-metadata-freshness-linux-2026-09-05.json) diagnostics
reproduce a limitation of the default size/mtime scan: a same-size edit whose
modification timestamp is restored returns the old indexed text as metadata-fresh.
An explicit `index --full` detects the content and recovers the correct quote.
`--freshness wait` alone is insufficient because it waits only after a detected change.
This limitation is now explicit in the README and fingerprint implementation.

Large-corpus ordinary create/same-size-edit/delete measurements remain separate.
`needle-scale-mutation.py --restore-mtime` retains the stronger failing stress case;
the default runner does not restore timestamps. Passing ordinary mutation checks
must not be reported as detection of arbitrary metadata-preserving writes. Stronger
content verification or reliable filesystem change tracking requires a separate
performance and portability design.

## Final executable verification

After the metadata-postings repair, the final query runs used the same fixed sources,
passages, model and queries. The operating systems were measured serially after
compilation and tests ended. Each run has 60 warm samples and 24 process-cold samples.

| Final platform | Warm p95 ms | Process-cold p95 ms | Peak query RSS bytes | Gates |
| --- | ---: | ---: | ---: | --- |
| Windows | 461.5 | 1,990.2 | 1,856,327,680 | All three pass |
| Native Linux under WSL2 | 91.3 | 1,695.7 | 1,850,847,232 | All three pass |

The [Windows report](../eval/results/needle-scale-final-windows-2026-09-05.json.gz)
binds executable `f6ada177e41ecb1c8d88394ce584216f3ef2d55f1aec8fa81970f63149694e2d`
to generation `01788614805361510100`. The
[Linux report](../eval/results/needle-scale-final-linux-2026-09-05.json.gz) binds
`5ba57206092f8dbd2c32e15be6748a8994f06f2228b1d3463a78d9b276ce4fac` to
generation `01788613647491640704`.

The [final parity check](../eval/results/needle-scale-final-parity-2026-09-05.json)
compares all 12 complete result objects and confirms byte-identical passage, vector
and source inventories against the original real-scale baseline on both platforms.
The benchmark also verifies generation immutability and the frozen raw source hashes.
Windows cold p95 is close to the 2-second gate; its maximum sample is 2,155.5 ms.
These results establish a pass for these samples, not a worst-case latency guarantee
or a statistically established margin. OS page-cache state is uncontrolled.

The remaining priorities are source-specific compiled caches and incremental graph/
n-gram updates, stronger content-change detection, raw extraction coverage (including
native eCFR appendices), and independent source-based relevance judgments. Query
parity proves the optimizations preserve answers; it cannot prove those answers are
complete or relevant to unseen tasks.
