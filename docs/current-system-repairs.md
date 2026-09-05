# Current system repairs

Approved 2026-09-04. This backlog implements Track A of `sect-search-vnext.md` and
supersedes conflicting assumptions in the historical v0.4 milestones. The evidence
and reproductions are in `project-review-2026-09-04.md`.

## Acceptance backlog

- [x] Bind verification to candidate bytes and dependencies; compare anchors and Action kinds; missing judgments fail.
- [x] Publish complete immutable generations; readers pin text and every index; test retained readers and failed publication.
- [ ] Run repeated concurrent-writer/process-crash campaigns; add a durable source-merge recovery journal before claiming machine-crash recovery.
- [x] Validate ordered text coverage, protected numeric/negation tokens, and table cell/header associations on maintained fixtures.
- [x] Preserve decimal signs/operators in OCR and hold missing secondary verification.
- [x] Expose passed/failed/unchecked/not-applicable evidence states and raw locators.
- [x] Resolve definition occurrences by scope and revision; expose ambiguity and missing text.
- [x] Resolve query hierarchy, metadata, links, and text against the same snapshot date.
- [x] Track exact-search inputs, registries, sidecars, extraction recipes, and inherited context.
- [x] Test incremental/full equivalence and indexed/brute grep parity after mutations; retain the real eCFR property test.
- [x] Reject cycles and duplicate structural identities; remove hidden traversal caps and report bounded traversal truncation.
- [x] Repair dependency/toolchain declarations, generated contracts, formatting, lint, and current documentation; configure Windows/Linux CI.
- [x] Implement a release gate that rejects absent independent evidence.
- [ ] Meet the independent real-corpus quality and performance gates on Windows and Linux.

## Verification

Promote the disposable audit probes into maintained regression tests. Mutation tests
cover edited/added/deleted/renamed files, registry-only edits, parent changes, wrong
anchors, missing judgments, decimal shifts, omitted negation, swapped table values,
historical overlays, duplicate terms, and missing source evidence. Publication tests
must leave a previous generation readable after failure. Ordinary tests run without
hosted models and never mutate the curated corpus. Human labels and live extraction
campaigns are separate acceptance evidence, never replaced by model agreement.

## Status recording

Only mark an item complete after its corresponding test passes. Record limitations
and any unrun platform or live-data checks in the implementation report; passing
fixture tests alone is not the generalized-release gate.

See [the implementation report](implementation-2026-09-04.md) for measured results,
new ingestion and knowledge paths, and remaining qualification work. Completed items
describe tested implementation behavior, not universal extraction or semantic fidelity.
