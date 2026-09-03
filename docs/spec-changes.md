# Proposed spec changes (candidate v0.5 edits)

Deviations from `sectgrep-spec-v0.4.md` are recorded here as proposals with the evidence that motivated them. Nothing here changes the spec until a human folds it into v0.5. The repository follows the proposal in the meantime so the code and the fixture stay consistent; each row says where.

| # | Spec section | Proposal | Motivation | Where applied | Status |
|---|---|---|---|---|---|
| 1 | B.2 `_source.yaml` | Add `id_template` and optional `anchor_template` next to `id_pattern`, and require `id_pattern` to use named groups. | `id_pattern` says whether a query is citation-shaped but not how to build the Work id and anchor from the match. The citation short-circuit needs both. | `fixtures/corpus/*/_source.yaml`, `proto/sect_proto/corpus.py` | Proposed (milestone 0) |
| 2 | B.2 tree | Non-leaf nodes (title, chapter, subchapter, part) are files with the same front matter and a minimal body. | `parent:` chains must resolve to real ids, and part-level `authority` / `citation` need a home. The spec shows only leaf files. | `fixtures/corpus/cfr-title-99/**` | Proposed (milestone 0) |
| 3 | B.2 versioning | Filename convention for Expressions: current `<file>.md`, prior `<file>@<effective>.md` in the same section directory. | The spec says "new Expression = new file, same id" but not how the files are named. | `fixtures/corpus/cfr-title-99/I/A/2/2.7/` | Proposed (milestone 0) |
| 4 | B.2 notices | Notice files carry an `actions:` list in front matter with the Action record fields from B.2, and the Action id is `<notice id>#instr-<n>`. | B.2 defines the Action record shape but not where it is written before `actions.jsonl` is built. | `fixtures/corpus/fr/2026/2026-00001.md` | Proposed (milestone 0) |
| 5 | E.1 question generation | The CRAwLeR adversarial filter threshold (rank <= 10) is a parameter, defaulting to 10, and the fixture run records the value used. | On a corpus of ~45 chunks rank 10 is the top quarter, which filters almost everything; the threshold is meant for corpora of thousands of sections. | `eval/questions/README.md`, `proto/sect_proto/questions.py` | Proposed (milestone 0) |
