# Document storage and reproducible ranking

Implementation continuation, 2026-09-05. This implements the document input and
storage part of [the retrieval plan](needle-retrieval-plan.md). It is opt-in and
has been exercised on an isolated copy of the nine-document diagnostic corpus.
The existing production corpus and its historical generations were not migrated.

## Input contract

`_source.yaml` now declares `input_mode: markdown` (the compatible default) or
`input_mode: document`. Unknown modes are rejected.

In document mode, each document has one `*.sections.json` bundle containing its
canonical section projections, including historical revisions. A projection keeps
its original virtual Markdown path and exact text. The bundle binds the organized
`*.document.json` artifacts by SHA-256; Rust checks the document identity, revision,
source, unit identity and raw-source hash. The organized artifact continues to hold
regions, native locators, source structure and identity evidence. The bundle recipe
is `canonical-markdown-v1`, with a Rust-owned schema and generated TypeScript types.

The compiler still constructs canonical Markdown projections from the organized
pipeline result. This avoids maintaining two different text renderers during the
storage migration. It does **not** prove that the projection or parser transcribed
every native source correctly; source alignment and normalization maps remain
separate requirements.

Markdown files inside a document-mode source are exports, not authoritative input.
Freshness tracks the bundles, raw assets, organized artifacts, identity/profile
sidecars and source registry. The reserved `SOURCE/exports/` directory is pruned
before walking. New ingestion pre-creates that directory; identical publication
bytes are not rewritten, avoiding needless timestamp changes on large bundles.

## Generation and query behavior

An immutable generation contains a `sections.bin` text store and a `sections.json`
catalog of byte offsets. Reads map this store lazily and retain the selected
generation. Canonical paths, citation addresses, historical reads, retirement,
source filters and section-body offsets continue to work without physical files
for the individual sections. A missing required store prevents a generation from
being considered complete.

Exact search uses the same ripgrep matcher for physical files and mapped text.
Globs, regex, context lines, annotations, bounds and exhaustive counts retain their
contract. The n-gram builder indexes those same virtual projections, so its
candidate list cannot silently exclude them. Unscoped grep retains the existing
raw-artifact search behavior; the JSON bundle encoding is excluded as a duplicate
representation. Use `-g '*.md'`, `--scope` or `--source` for section-only queries.

The harness stages and publishes bundles through its existing publication barrier
and immutable-generation workflow. It carries previous bundles and source artifacts
when compiling new revisions. Its cache distinguishes input modes while preserving
review identities when a published run resumes.

This removes the per-section filesystem requirement. It is not complete text
deduplication: source-region evidence, the parsed-document cache and retrieval
passages still retain derived text. Changed non-Markdown dependencies also retain
the conservative rebuild behavior. Further cache and layout work should be judged
against the measured baseline, not assumed to be faster.

## Ranking defect found by the comparison

The migration preserved every passage byte, but initially changed some results.
Tantivy's document addresses were breaking lexical ties, and segment layout also
changed the last floating-point bits of some scores. Reciprocal-rank fusion then
amplified those arbitrary ordinal changes.

Lexical ranking now compares BM25 scores at millipoint precision and breaks ties by
durable chunk address. It includes the entire tie at the candidate boundary before
selecting the requested count. A test with 240 identical candidates, reversed build
order, incremental segments and a 17-result limit checks both ordering and boundary
selection. Very broad queries with large tied sets can require more candidate work;
this is an explicit performance tradeoff to measure at scale.

## Reproduction

The [matched comparison](../eval/results/needle-document-store-2026-09-05.json)
uses the same release binary, model and passage policy on both corpora. All 9,576
canonical projections, 5,799 stored passages and source-region artifacts agree.
Four search responses (including evidence) and four annotated exact-search probes
agree. These are diagnostic cases, not independent relevance judgments.

| Measurement | Markdown inputs | Document inputs |
| --- | ---: | ---: |
| Tracked input files | 9,669 | 102 |
| Files in the immutable generation | 9,696 | 131 |
| Warm MCP p95, default freshness, 20 samples | 53.2 ms | 16.6 ms |
| Process-cold CLI p95, 12 samples | 381.5 ms | 333.6 ms |
| Peak MCP RSS | 490.6 MB | 484.6 MB |
| Generation logical bytes | 341.8 MB | 361.4 MB |

The warm measurement improved about 3.2×. The OS cache was uncontrolled for the
process-cold measurement; this is a small local diagnostic corpus. Logical storage
increased by 19.6 MB because the initial layout retains the bundle input alongside
the mapped text projection. It trades file operations for a derived copy; removing
that duplication is still useful work. No general memory or 100k-scale claim follows.

The independent mechanical audit checked 9,689 source spans, 21 support spans, raw
hashes and the actual model tokenizer; it passed with a maximum of 796 input tokens.
Final validation passed 67 Rust tests on Windows, 66 on Linux, 139 TypeScript tests,
workspace builds, strict Clippy, Rust formatting and whitespace checks. Tests include
legacy/virtual grep parity, historical and retired reads, failed publication,
ignored exports, source-hash binding and resumed review identity preservation.

Build the TypeScript packages and the release CLI, then create a new isolated copy:

```powershell
pnpm -r build
cargo build --release --locked -p sect-cli --bin sect
node eval/needle-storage.mjs corpora/needle-retrieval-v5 corpora/needle-document-store-example
target/release/sect.exe index corpora/needle-document-store-example --embedding minishlab/potion-retrieval-32M --passage-target 512 --passage-max 800
python -X utf8 eval/needle-storage-validation.py --after corpora/needle-document-store-example
```

The migration script refuses an existing destination. To migrate an existing
organized source deliberately, `sect-convert pack-source --corpus CORPUS --source
SOURCE_DIRECTORY` writes bundles and switches the source registry last. It retains
the old Markdown files. `sect-convert export-source` with the same arguments creates
inspectable copies under `SOURCE/exports/`. Run `sect index` to validate and publish
the resulting input; failed indexing retains the previous generation.

For new harness ingestion, set `input_mode: document` on source entries in the
pipeline manifest. An existing source registry governs all documents in that source;
an explicit conflicting mode is rejected. Direct document-mode ingestion requires
the organized, identity-checked pipeline artifact.

## Qualification limits

The matched diagnostic corpus has six real documents and three generated fixtures.
Byte parity and regression tests establish mechanical compatibility, not independent
relevance or semantic completeness. [Contextual-model comparisons](needle-model-experiments.md)
and [real 100k-passage Windows/Linux query measurements](needle-scale-implementation.md)
are now recorded. The large workload uses legacy native XML inputs, so it does not
qualify the document-bundle mode at that scale. Source normalization maps,
independent judgments and document-specific compiled caches remain open.
