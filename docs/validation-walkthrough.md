# Validating Sect on the creation pilot

The software runs and its targeted failure checks pass. Extraction accuracy,
retrieval usefulness and semantic-relation gains still require independent
judgments. This walkthrough keeps those claims separate and makes each check
repeatable. Run commands from `C:\Users\amazi\code\sect`.

## Evidence from September 4, 2026

| Check rerun | Observed result | What it establishes |
| --- | --- | --- |
| Pipeline end-to-end and failure tests | 6 passed | Healthy documents publish; failed documents are held; resume preserves review identities; rejected text blocks subsequent publication; worker-lock, budget, claim-disagreement and held-out protections work in tested cases. |
| Evaluation tests | 8 passed | Missing labels cannot qualify; revision IDs, split isolation, no-answer scoring and freeze bindings are checked. |
| Three queries across five retrieval modes | 15 CLI/MCP comparisons matched | Both interfaces returned identical search results on the same generation. |
| Search, then read an exact revision | Original-file SHA-256 matched; two native source locations returned | The example result can be traced to stored source bytes. Human source alignment remains unchecked. |

The fresh corpus contains 33 documents and 11,090 searchable units, including
document roots. It has zero accepted concepts and zero accepted semantic
relations. Hierarchy edges are not evidence of semantic graph quality.

The new [machine-readable smoke report](../eval/results/validation-walkthrough-2026-09-04.json)
records generation `01788574854563721700`, binary/task hashes, each result,
timings and qualification blockers. Its `qualified: false` is expected.
The broader Windows/Linux suite results are recorded in the
[implementation report](corpus-creation-implementation.md).

## 1. Reproduce the automated checks

```powershell
pnpm --filter @sectgrep/harness exec vitest run test/pipeline-e2e.test.ts test/pipeline-failures.test.ts
python -m unittest discover -s eval -p test_qualification.py -v
python eval/qualification.py --binary target/debug/sect.exe --corpus corpora/corpus-creation-pilot-v2 --tasks eval/corpora/creation-smoke.jsonl --output review/validation-smoke-local.json --split smoke --repeats 1
```

The last command compares body BM25, plain hybrid, Sect with relations off,
explicit relations and verified relations. It rejects CLI/MCP differences or a
generation change during the run. These three tasks are timing-only and cannot
produce accuracy scores. No hosted enrichment calls or human decisions are
needed. The pipeline tests use temporary fixture corpora.

## 2. Follow one search result back to the source

```powershell
target/debug/sect.exe --corpus corpora/corpus-creation-pilot-v2 search "self-employed borrower income documentation" --limit 3
target/debug/sect.exe --corpus corpora/corpus-creation-pilot-v2 --json read "DOC:lending:fannie-self-employed/u000011@2026-09-04" --ancestors
```

In this run, the top hit was **Income Verification for Self-Employed
Co-Borrowers**. The read response includes the full paragraph, revision,
ancestors, original-file hash and heading/paragraph DOM locations. Compare the
original source at those locations with the extracted paragraph, checking the
condition and negation as well as the words. A matching file hash proves source
identity; it does not prove that extraction preserved meaning.

Other hits can show only headings in their search snippets even when `read`
returns a full section. Inspect the full result before judging relevance.

One useful diagnostic from this run: **clinical prediction model validation**
ranked language-modeling sections first, including **3.3. Char LSTM Predictions
4. Experiments**. This deserves investigation. Independently establish whether
the corpus contains an answer before deciding whether retrieval or abstention
failed. Do not turn this unjudged smoke query into a claimed accuracy score.

## 3. Review the extraction and ontology

Use the running review app on port 4178 with its session URL. If it is stopped,
restart it and use the new URL it prints:

```powershell
node packages/sect-harness/dist/cli.js review --run review/corpus-creation/review-pilot --port 4178
```

Start in **Extraction** with a ten-item batch. Compare original source and
extracted structure. Check text, numbers/units, negation and conditions, reading
order, hierarchy, and table header/cell associations. Record a reason for each
acceptance, rejection or deferral. Complete all 60 sampled regions across
lending, ML and biomedical documents before claiming the planned extraction
review is complete. Ten items are a useful first session, not qualification.

In **Knowledge**, review the two profile proposals for useful vocabulary,
unambiguous relation direction, scope and source grounding. An approved profile
does not establish correct relations. Accepted relation lots still need source
review, including qualifiers and missing required context. Record precision
and coverage separately; publishing no relations cannot demonstrate success.

A rejection holds a subsequent publication. It does not automatically retract
an already selected generation or apply a source correction.

## 4. Measure whether search helps

In **Benchmark**, independently write/check the 100 tuning questions and label
the exact source revisions that answer each one. Label supporting evidence
separately: exceptions, definitions, conditions and cross-document context.
Include cases with no answer in the corpus. Machine-drafted questions need
human review, and retrieved hits must not define the gold answers.

Compare all five modes using the same corpus and labels. Use tuning failures
to improve the system. Then review topic overlap between document families and
freeze the parser, profile, prompt and ranking recipes. Only then unlock and
judge the 200 held-out questions. Do not tune on those results. The
[implementation report](corpus-creation-implementation.md#use-the-implementation)
documents gold export and freeze commands.

The existing acceptance gates are:

| Property | Required evidence |
| --- | --- |
| Locate/definition retrieval | Recall at 5 at least 90%, separately for lending and research. |
| Correct accepted relations | Precision at least 95%, with coverage and sample size reported. |
| Useful relationship expansion | Supporting-evidence recall improves at least 10 percentage points over relations off; primary precision falls no more than 2 points. |
| Questions without an answer | At least 90% correct abstention decisions. |
| Structural and historical behavior | All defined exact, structural and temporal invariants pass. |
| Practical agent usefulness | Three fixed-agent comparisons show at least 30% fewer tool calls with no accuracy regression. |

## 5. Validate breadth and scale separately

The public pilot covers HTML, PDF and XML. Qualify scans, Office documents,
spreadsheets and difficult layouts with independently reviewed sources before
claiming support generalizes. Report failures by format and domain so a large
easy collection cannot hide a weak parser or domain.

The scale target is 100,000 real searchable units on Windows and Linux, with
warm p95 at most 500 ms, cold CLI p95 at most 2 seconds, and query RSS at most
2 GiB. The current corpus is smaller. The initial diagnostic used a **debug
build** and observed roughly 4.2-second cold hybrid searches and 488 MiB peak
warm MCP RSS. Those timings do not represent optimized Rust performance.

A subsequent current-code **release build** measured Sect at 200 ms warm p95,
881 ms process-cold CLI p95 and 479 MiB peak warm MCP RSS across the measured
modes. It used three queries with three repetitions per mode; all 27 CLI/MCP
comparisons matched. The nine query/mode results also matched the earlier debug
results. See the [release measurement](../eval/results/rust-release-performance-2026-09-04.json).
This is a small diagnostic sample with filesystem caches warmed, not a
representative workload or a 100k-unit qualification. Existing scale blockers
remain open.

The [subsequent Rust performance pass](rust-performance-implementation.md) includes
a controlled comparison on the same index generation. Pilot hybrid p95 improved
from 85 to 50 ms warm and 758 to 383 ms process-cold. At 101,001 synthetic units,
hybrid p95 improved from 1,104 to 831 ms warm and 4,245 to 2,620 ms process-cold.
The default 100k path still misses both latency targets, and peak warm MCP memory
increased from 1,249 to 1,662 MiB. All measured before/after results matched;
retrieval relevance and real-corpus scale qualification remain separate work.

Immediate next session: complete the first extraction batch, then independently
judge ten tuning questions covering direct lookup, terminology mismatch,
exceptions, tables and missing answers. Use the resulting failures to choose
the next repair, then complete the full review and held-out evaluation.
