# Evaluation

The repository contains three kinds of evidence. Keep their conclusions separate.

| Evidence | Entry point | What it establishes |
| --- | --- | --- |
| Fixture regressions | [Contributor checks](../CONTRIBUTING.md) | Contracts, failure recovery and behavior on included cases. |
| Frozen-corpus diagnostics | [Needle retrieval](../docs/needle-retrieval-implementation.md), [scale](../docs/needle-scale-implementation.md), [cache](../docs/compiled-passage-cache.md) | Mechanical integrity and measurements on bound inputs/binaries. |
| Independent qualification | [Review walkthrough](../docs/validation-walkthrough.md), `qualification.py` | Source fidelity and retrieval quality, only after independent labels and required gates exist. |

## Fresh checkout

Follow the root README to build and index `fixtures/corpus`. The Python invariant
tests use the standard library and checked-in evidence; they need no raw corpus,
hosted keys or Docling installation:

```sh
python -m unittest discover -s eval -p "test_*.py"
```

Native extraction and pipeline integration fixtures run in the TypeScript suite.
Passing them does not establish accuracy on every PDF, Office layout or domain.

## Reproducing a real experiment

`corpora/` contains acquisition manifests, hash locks and task definitions, not the
acquired document corpus. Follow the matching implementation report to acquire,
prepare and index inputs. Root-level `raw/`, `corpora/`, `work/` and `review/` are
local, ignored data. Optional parser/model experiments require their own pinned
dependencies. Some historical scripts refer to local WSL paths and exact archived
generations; they are experiment records, not fresh-checkout entry points.

For example, `needle-baseline.py` requires the original six-document generation;
`needle-navigation-validation.py` requires both isolated navigation corpora and the
retained Docling capture. Re-extracting with today's code is a new experiment, not a
reproduction of those original source representations.

Use runners with explicit `--binary`, `--corpus` and a **new** `--output` path for new
measurements. Run them serially after builds/tests, preserve immutable generations,
and record the exact executable and input hashes. Consult each runner's `--help`
where available and its implementation report for prerequisites.

## Reading results

[results/README.md](results/README.md) explains the lossless report archives. Small
reports remain plain JSON/Markdown. Large scale query captures are `.json.gz`, with
original byte hashes in `results/archives.json`; decompression preserves the exact
bytes referenced by the historical parity checks. No measurement was rerun or
rewritten to create the archives.

Timing-only tasks and parser-agreement checks cannot supply relevance labels.
`qualification.py` rejects missing judgments, split leakage, unbound held-out
recipes and incomplete measurements. A report with `qualified: false` is evidence
of an unfinished quality gate, not a result to relabel as passing.
