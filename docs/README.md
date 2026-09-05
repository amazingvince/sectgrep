# Documentation

Start with the [project README](../README.md) for a working fixture example and
[CONTRIBUTING.md](../CONTRIBUTING.md) for build and test commands.

## Current implementation

| Topic | Read |
| --- | --- |
| Source units, coherent passages and evidence packets | [Needle retrieval implementation](needle-retrieval-implementation.md) |
| Document bundles and canonical section storage | [Document store](document-store-implementation.md) |
| Native Word/PDF locations and passage expansion | [Source navigation](source-navigation-implementation.md) |
| Scale measurements and query-loading changes | [Scale implementation](needle-scale-implementation.md) |
| Reusing compiled passages on updates | [Compiled passage cache](compiled-passage-cache.md) |
| Resumable ingestion, profiles and review | [Corpus creation implementation](corpus-creation-implementation.md) |
| Human source and retrieval judgments | [Validation walkthrough](validation-walkthrough.md) |
| Evaluation prerequisites and archived evidence | [Evaluation guide](../eval/README.md) |
| Choosing CLI/MCP verbs | [Agent guide](SKILL.md) |

Implementation reports are dated evidence. Their test counts, generations, failures
and timings describe the named run, not every later commit. The scale and cache
reports supersede earlier performance observations where they explicitly compare
the same workload; they do not replace independent quality judgments.

## Design and history

- [Original v0.4 specification](../sectgrep-spec-v0.4.md), retained unchanged.
- [Goal and milestone history](../GOAL.md).
- [Project review](project-review-2026-09-04.md) and [current-system repairs](current-system-repairs.md).
- [Connected-search plan](sect-search-vnext.md) and [initial implementation](implementation-2026-09-04.md).
- [Corpus creation plan](corpus-creation-plan.md).
- [Needle retrieval plan](needle-retrieval-plan.md), which separates source regions,
  canonical sections and retrieval passages beyond the original file/chunk model.
- [Model experiments](needle-model-experiments.md) and [Rust performance investigation](rust-performance-implementation.md).
- [Decisions](decisions.md) and [spec change proposals](spec-changes.md).
- [Legacy ingestion agent guide](SKILL-ingest.md) and [Python prototype](../proto/README.md).

Historical experiment commands can depend on ignored raw files, earlier generations,
local captures and executables. Use the fixture checks for a fresh checkout, and the
source locks and reproduction instructions for a new real-corpus experiment.
