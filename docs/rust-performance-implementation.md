# Rust performance implementation — 2026-09-05

This pass reduces repeated query work, defers source-evidence loading, and reuses
immutable source snapshots. Default freshness checking still stats every tracked
file and directory. Search continues to use exact vector scoring and the existing
ranking recipe.

## Changes

- `sect-index/src/search_state.rs` retains chunk/revision lookups, incoming-reference
  counts and explicit-edge adjacency for each immutable generation. A four-entry
  LRU caches eligible revisions by date, scope, source, kind and supersession mode.
  Vector row selections are computed once per selection.
- `sect-lexical` retains its Tantivy reader for the generation. It borrows filtered
  revision sets and uses an `AllQuery` when every indexed revision is eligible.
  The constant score is retained so the optimization preserves ranking semantics.
- Source regions load lazily through `Index::regions()` when read/status needs
  evidence. Ranked search no longer deserializes that artifact. New builds persist
  the default dated tree projection; all revision history remains available.
  An optional manifest field makes existing schema-4 generations compatible.
- Freshness scans reuse parsed fingerprints, native Windows path buffers and a
  bounded worker pool. They cache the scan plan, not the default filesystem
  observations. Changed metadata still triggers content hashing and directory
  changes still trigger discovery.
- Incremental builds skip the redundant copy of the previous source snapshot.
  Unchanged files hard-link from the **previous immutable generation**, with a copy
  fallback, and retain hash verification. Mutable canonical input files are never
  hard-linked into a generation. This saves copied bytes; full-corpus validation
  and hashing still mean incremental work is not proportional only to changes.
- Per-document fingerprinting and parsing run in a bounded pool, with indexed
  collection preserving deterministic document/error order.
- Full Tantivy builds finish in a private sibling directory and close writers
  before moving the completed layer into its destination. Worker failures now
  report the underlying error. Repeated Windows 100k builds previously failed with
  access denied creating a `.fieldnorm` file, including with the baseline binary.
  The staged full build succeeded; the external cause of the original denial has
  not been established.

## Validation

After the final code changes:

- Windows: 60 Rust tests passed.
- Linux (Ubuntu 24.04 in WSL, native Linux workspace): 59 Rust tests passed.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passed.
- Three harness publication/end-to-end tests passed against the release binary.
- Full builds completed with no validation issues for the 101,001-unit synthetic
  corpus and the 11,090-unit public pilot.

The Rust command was `cargo test --workspace --locked -- --skip real_corpus`.
The expensive existing real-corpus n-gram test was excluded; the regular n-gram
tests passed. The n-gram algorithm was not changed in this pass.

New/extended regressions cover cached readers surviving generation publication,
historical/future revisions, selection eviction, scope/source/kind isolation,
unchanged source bytes remaining pinned after subsequent canonical edits, lazy
evidence loading, and Windows notification invalidation after immediate edits,
renames, deletions and generation changes. Existing tests cover failed publication,
incremental/full equivalence and knowledge evidence bindings.

Logs are in `review/rust-performance/`. These are local generated artifacts.

## Measured results

The same-generation Windows release comparison preserved **all 18 query/mode
result objects** across the two corpora. All **108** measured warm-MCP/cold-CLI
pairs matched (27 per corpus per binary). These checks include ordering, scores,
explanations and relationship paths returned by these tasks.

| Corpus | Mode | Warm p95 before → after | Process-cold p95 before → after |
| --- | --- | ---: | ---: |
| Public pilot: 11,090 units | Body BM25 | 75 → 52 ms | 614 → 274 ms |
| Public pilot: 11,090 units | Sect hybrid | 85 → 50 ms | 758 → 383 ms |
| Public pilot: 11,090 units | Verified relations | 90 → 51 ms | 740 → 397 ms |
| Synthetic: 101,001 units | Body BM25 | 1,042 → 782 ms | 3,911 → 2,331 ms |
| Synthetic: 101,001 units | Sect hybrid | 1,104 → 831 ms | 4,245 → 2,620 ms |
| Synthetic: 101,001 units | Verified relations | 1,173 → 822 ms | 4,306 → 2,561 ms |

Hybrid warm latency fell 41% on the pilot and 25% on the synthetic corpus. Cold
latency fell 50% and 38%, respectively. **The 100k default path still misses the
500 ms warm / 2-second cold targets.**

Peak warm MCP working set, across the measured modes, increased from **475 to
488 MiB** on the pilot and **1,249 to 1,662 MiB** on the synthetic corpus. The
retained state trades memory for latency; this pass did not reduce total query
memory. Both measurements remain below 2 GiB, with substantially less headroom at
100k. Do not extrapolate these memory figures to multiple retained generations,
concurrent processes or graph-heavy real corpora.

The authoritative comparison is
[rust-performance-comparison-2026-09-05.json](../eval/results/rust-performance-comparison-2026-09-05.json).
The before/after files retain the complete rows. These same-session baseline
measurements supersede the older pilot timing comparison; differences in generation
and machine/filesystem state make cross-session speedup claims less reliable.

## Measurement method

`review/rust-performance/compare.py` runs the retained pre-change release binary
and current release binary against each newly built generation. The runner uses
three queries, three repetitions and three modes: body BM25, Sect hybrid, and
verified relations. It checks every warm MCP response against a fresh CLI process
and compares all result objects between the two binaries. Binary hashes, generation
IDs, task hashes, individual timings and memory measurements are in the JSON
reports under `eval/results/rust-performance-*-2026-09-05.json`.

These are Windows diagnostic timings with warmed filesystem caches. “Cold” means
a new CLI process, not cold storage. `--freshness no` prevents automatic rebuilding;
it still performs freshness checks. `SECT_FRESHNESS_WATCH` is explicitly unset for
the default comparison. Builds/tests finish before query measurements begin.

Reproduce the current-binary pilot run from the repository root:

```powershell
cargo build --release --locked -p sect-cli
target/release/sect.exe index corpora/corpus-creation-pilot-v2 --full --json
python eval/qualification.py --binary target/release/sect.exe --corpus corpora/corpus-creation-pilot-v2 --tasks eval/corpora/creation-smoke.jsonl --output eval/results/rust-performance-recheck.json --split smoke --repeats 3 --variants body-bm25 sect verified
```

For the synthetic scale run, substitute `corpora/qualification-synthetic-100k` and
`eval/corpora/synthetic-tasks.jsonl`. Keep the notification environment variable
unset for the default path. Increasing repetitions helps estimate timing variation;
adding independently chosen queries is necessary to broaden workload coverage.

The full-build measurements were 130.4 seconds for the synthetic corpus and
13.7 seconds for the public pilot. On the synthetic build, source discovery and
parsing took 58.5 seconds, snapshot/structural writes 38.0 seconds, lexical indexing
4.1 seconds and semantic indexing 24.9 seconds. Other tests were running during
these builds; these are observed durations, not controlled build speedup claims.

## Optional native Windows freshness cache

`SECT_FRESHNESS_WATCH=1` enables an experimental notification shortcut on fixed,
local NTFS volumes. It watches the corpus recursively and its parent, caches only
a successful quiet scan, and rescans on notifications, errors, root replacement or
60-second expiry. Unsupported paths/filesystems fall back to full scans. The
cache retains at most four roots.

This remains off by default. Windows notifications can be delayed for unflushed
writes and do not establish coverage of changes through external aliases or
linked targets. The immediate closed-write regression tests do not prove every
filesystem edge case. See Microsoft's
[notification API contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstchangenotificationw).

A separate short diagnostic measured hybrid warm p95 of **5.8 ms** on the pilot
and **42.2 ms** at 100k with notifications enabled. All measured result objects
matched the default path. This strongly indicates that repeated full freshness
scans dominate warm latency on these workloads. It does **not** qualify the
notification mode: the timing run did not exercise writers, external aliases or
the periodic full rescan. Those figures must not be substituted for default-path
performance. See the
[experimental result](../eval/results/rust-performance-watch-2026-09-05.json).

A separate one-query full-scan worker sweep measured roughly 3,958 / 1,252 /
1,046 / 809 / 772 ms mean warm latency at 1 / 4 / 8 / 16 / 32 workers. The existing
16-worker default remains: doubling workers produced only a small gain and still
missed the target. This is diagnostic evidence from one machine, not a portable
tuning rule. See [worker measurements](../eval/results/rust-stat-threads-2026-09-05.json).

## Remaining work

This performance pass does not establish retrieval relevance, extraction accuracy
or ontology usefulness. The public pilot still has no accepted knowledge
relations, and these smoke questions have no independent relevance judgments.
Synthetic scale evidence does not qualify 100,000 real searchable units. Large
historical-date workloads, many alternating filter combinations, concurrent
readers and graph-heavy corpora need separate measurement.

Default freshness remains linear in tracked paths. Exact vector search remains
linear in eligible vectors. Large JSON tree/chunk artifacts still contribute to
cold startup and memory. Incremental builds still rebuild structural artifacts and
copy mutable derived layers. Use the measured remaining bottlenecks to select the
next change; do not infer production qualification from a small latency sample.

The next performance priorities, in order, are:

1. Qualify a change-tracking contract that can avoid most filesystem sweeps while
   reporting freshness honestly. Cover concurrent/unfinished writes, root changes,
   linked inputs, missed events, recovery and fallback behavior before changing the
   default. The experimental notification cache is useful evidence, not that proof.
2. Reduce retained query-state memory and cold JSON loading. Profile allocations,
   share repeated identifiers and evaluate a compact, versioned query artifact.
   Preserve old-generation readers and historical-date behavior during migration.
3. Measure the resulting system on independently judged real corpora with many
   revisions and accepted knowledge relations, including concurrent MCP usage.

The 42 ms short warm hybrid diagnostic gives no evidence that approximate vector
search should be the first priority for this measured 100k workload.
