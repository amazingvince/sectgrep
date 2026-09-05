# Reusing compiled document passages

2026-09-05. This implements the next step from the needle-retrieval review: an update
can reuse unchanged documents' compiled passages instead of tokenizing and assembling
the entire corpus again. It preserves the current passage recipe and query contract.

## What is cached

Each immutable generation gains `compiled-passages.json`, a dependency manifest with
input fingerprints, passage IDs and output checksums. Passage text remains in the
existing `chunks.jsonl`; the cache does not introduce another authoritative text store
or a file per source section. A rebuild leaves the published passage and cache
artifacts intact and writes its replacements into a new generation.

Legacy Markdown sections are independent cache groups. For organized sources, all
sections participating in the same native document form one group: merging peers,
table headers, captions and footnotes can cross section boundaries. Overlapping
artifact memberships are joined before deciding which groups can be reused.

The fingerprint includes parsed content and metadata, the exact inherited title/
context projection, native document artifacts, source/schema/compiler versions,
passage policy and the effective tokenizer configuration. Tokenizer object keys are
canonicalized so vocabulary serialization order does not cause unnecessary misses.
The compiler and cache use the same function to resolve effective parent context.

An update compiles all members of a changed group, reattaches native support and
rebinds passage addresses. Unchanged groups reuse prior passages after checking their
membership and output checksum. Final ordering, exact source spans and lexical/vector
change detection retain their existing contracts. Missing, incompatible or corrupt
cache records cause recomputation. Missing or unreadable prior passage inventories
still force a complete layer rebuild.

Validated cache hits transfer ownership of their passages out of the prior inventory.
They do not retain cloned old/new copies of the same passage text. Remaining old
passages are released once changed/removed Expression identities have been collected,
before lexical, vector and n-gram work. This preserves deletion bookkeeping while
reducing unnecessary overlap in the rebuild's object lifetimes.

## Operation and visibility

The cache is populated on the next actual build. An unchanged older generation may
remain a no-op until an input changes; `sect index --full` explicitly builds from
source and populates the cache. A full build bypasses passage reuse. A cache is derived
data and is not required for reading an existing generation.

Build JSON, the generation manifest and successful build logs include `passage_cache`:
`compiled_documents`, `reused_documents`, `compiled_groups`, `reused_groups` and
`reused_passages`. Here a Rust `Document` is a canonical source section, so these
counts differ from raw PDFs/XML files. `layer_ms.passages` includes loading the prior
passage inventory, checking dependencies/checksums and compiling misses; `structural`
continues to report tree/graph/model preparation separately.

## Validation

The Rust workspace passes 81 tests on Windows and 79 on Linux, with strict all-target
Clippy on both. The two additional Windows cases exercise native OS behavior. Separate
`real_corpus` qualification tests are skipped; real workload results come from the
runner below. Formatting checks also pass.

New regression coverage checks:

- An unrelated exact-search file reuses all passages; one Markdown body edit compiles
  only that section, retains an old pinned generation and returns the new text.
- Deletion removes lexical evidence while reusing surviving sections; incremental
  passage bytes agree with a forced full build.
- Parent scope changes invalidate affected descendants. Advancing the parent revision
  selected during compilation changes only the affected context dependency.
- A native artifact-only footnote change recompiles its document group and updates
  support while preserving an unrelated document. Passage-policy changes invalidate
  all groups; results match a full rebuild.
- Effective tokenizer changes invalidate cached compilation even when the model path
  stays the same; vocabulary map ordering alone does not.
- Missing files, malformed cache JSON, unsupported versions, changed checksums and
  absent passage IDs recover by recompilation without losing searchable evidence.

The scale runner creates two synthetic probe sections beside the three frozen real
regulatory titles, edits one and removes both. It measures automatic refresh, checks
compile/reuse counts, verifies the edited lexical result, and requires the original
passage/vector bytes and canonical diagnostic answer to return after cleanup. Raw
regulatory inputs and the prior immutable generation must retain their hashes.

```powershell
python eval/needle-compiled-cache-validation.py --binary target/release/sect.exe --corpus corpora/needle-scale-real-v3 --output eval/results/needle-compiled-cache-new-run.json
```

Run it serially after builds and tests, with a fresh baseline. It refuses an existing
probe directory or output file. Cleanup removes only its recognized probe files;
failure evidence is retained. The first Windows attempt found invalid parent metadata
in the probe fixture and published nothing; the corrected runner gives the child an
explicit parent. The failed report is retained separately from measurements.

### Windows measurement

The [Windows result](../eval/results/needle-compiled-cache-windows-v2-2026-09-05.json)
uses executable SHA-256 `7c040b84ca8f56e3d911e371ff62d1e09fd805603a596f9d01d023db78dd8398`.
The initial corpus has 45,320 canonical sections and 117,075 passages, of which
111,091 are content. Two probe sections are temporary additions.

| Operation | Whole refresh seconds | Passage stage seconds | Sections compiled | Sections reused |
| --- | ---: | ---: | ---: | ---: |
| Seed probes and initial cache | 192.7 | 110.4 | 45,322 | 0 |
| Edit one section | 85.6 | 7.45 | 1 | 45,321 |
| Remove probes | 88.1 | 3.78 | 0 | 45,320 |

The edited probe returns its new text through exact and ranked search. Cleanup
restores byte-identical original passages and vectors and the complete canonical
diagnostic answer. The three real raw XML hashes and original-generation artifact
hashes remain unchanged. Final generation: `01788619089606320100`.

The one-section edit's other stages take 17.7 seconds for input work, 12.0 seconds
for structural/model preparation, 15.5 seconds for structural/snapshot writes and
21.0 seconds for n-grams. Its lexical and semantic update stages take 825 and 414 ms.
This verifies selective compilation, while exposing the next large update costs.
Seed-versus-edit timings describe different work; they are not a controlled before/
after speedup ratio. Peak MCP RSS across seeding and successive updates is
6,739,607,552 bytes; this optimization does not establish lower rebuild memory.

The first [Linux run](../eval/results/needle-compiled-cache-linux-2026-09-05.json)
also passed, with a 38.4-second edit and a 3.54-second passage stage. Its peak MCP RSS
including cold cache seeding reached 11,726,413,824 bytes. This exposed unnecessary
cloning of reused passage text and led to the ownership-transfer change described
above. Cold cache seeding and a run that begins with a populated cache are different
workloads; their peaks must not be treated as a controlled memory comparison.

### Final binaries

Both final runs begin with a populated cache, use the ownership-transfer implementation,
and execute serially after compilation and tests. They compile two new probe sections
on creation, one on edit and zero on deletion. The edit reuses 45,321 sections containing
117,076 passages. Both runs pass the edited exact/ranked-search checks, canonical
answer equality, original passage/vector byte equality and source/old-generation hashes.

| Platform | One-section refresh seconds | Passage stage seconds | Peak MCP RSS across all three updates |
| --- | ---: | ---: | ---: |
| Windows | 86.2 | 7.14 | 5,465,931,776 bytes |
| Native Linux under WSL2 | 38.1 | 2.59 | 8,496,713,728 bytes |

These are single edit measurements, not p95 estimates or a controlled speedup ratio.
The final Linux edit spends 11.3 seconds on n-grams and 10.2 seconds on structural/model
preparation; input work and structural/snapshot writes take another 3.0 and 5.1 seconds.
The final dependency manifest is 20,603,951 bytes on each platform, with no duplicate
passage bodies stored in it. Rebuild memory remains substantial even after ownership
transfer; smaller resident working sets require further work.
The final Windows and Linux cache manifests are byte-identical (SHA-256
`9f5629dd12b3bd6585fad565c81f759348a49b50ec58c416c6dcd0046857151d`).

- [Final Windows result](../eval/results/needle-compiled-cache-final-windows-2026-09-05.json):
  executable `8de1ea236f7753c66e2efbbf781a550881b37d85e64eacf1a09873be0db43db9`,
  final generation `01788620000449549700`.
- [Final Linux result](../eval/results/needle-compiled-cache-final-linux-2026-09-05.json):
  executable `c2a57128e3d263ea4fb7bfa958de20b81799bf5084a5f5819cd8da3ba912bcd0`,
  final generation `01788620218601532520`.

Final test/build logs use the prefix `review/needle-retrieval/compiled-cache-owned-`.
The final suites retain 81 passing Rust tests on Windows and 79 on Linux, with strict
Clippy on both; Rust formatting, Python syntax and whitespace checks pass. No changes
to TypeScript, the passage policy or the embedding model were needed for this cache.

## Remaining costs

This removes unnecessary passage compilation, not every corpus-sized operation.
Fingerprinting, validation, tree/graph work, source snapshots, prior passage loading,
checksum verification, structural writes and n-grams still process substantial data.
Cache misses can still overlap current and previous compilation data. It does not establish
constant-time updates or a small rebuild working set. Native document groups deliberately
invalidate together when their cross-section dependencies change.

Default metadata freshness still assumes that edits change size or mtime. An edit that
preserves both requires `index --full`; the new cache does not alter that policy.
Independent retrieval/extraction judgments remain separate from mechanical parity.
