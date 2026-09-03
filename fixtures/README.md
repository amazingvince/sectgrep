# Fixture corpus

`fixtures/corpus/` is a small synthetic corpus in the spec B.2 contract, used by CI and by the milestone-0 prototype. **Everything in it is fictional.** "Title 99, Fixture Occupational Standards" does not exist; the sections are written in the style of the Code of Federal Regulations so that citation patterns, paragraph labels, cross-references, definitions, tables, overlays, notices, and versioning all look like the real thing without quoting any real rule.

## Sources

| Directory | `kind` | Precedence | What it exercises |
|---|---|---|---|
| `cfr-title-99/` | base | 100 | Title > Chapter I > Subchapter A > Parts 1-3 > sections. Non-leaf nodes are files too (spec-changes #2). Part 1 general provisions, Part 2 walking-working surfaces and egress, Part 3 recordkeeping. |
| `city-amendments/` | overlay | 200 | `AM-1` **overrides** § 2.8 (guardrail systems) whole. `AM-2` **narrows** § 1.4(b) and § 2.10(b) at the anchor level. |
| `fr/` | notice | 100 | `FR:2026-00001` amends § 2.7(b) (fixed-ladder cages). Its Action produces the 2026-01-01 Expression of § 2.7; the 2024-01-01 Expression is kept as `99-2.7@2024-01-01.md` (spec-changes #3). |
| `notes/` | note | 0 | One synthesized note comparing exit-route width across the base rule and the city overlay. Must never outrank the rule text. |

## What the contract requires of every section file

Front matter: `id` (canonical Work id), `node`, `source`, `title`, `parent`, `order`, `effective`, `supersedes`, `superseded_by`, `amended_by`, `overrides`, `narrows`, `defines`, `authority`, `citation`, `tags`, `context` (50-100 token prefix that names at least one referenced section's subject and does not paraphrase the body), and `provenance` (`raw`, `raw_sha256`, `locator`, `legal_status`, `ingest_run`, `confidence`, `verified_by`).

Body: one `#` heading with the section number and title, then paragraphs labeled `(a)`, `(b)`, `(1)`, `(i)`. Cross-references are markdown links whose target is a Work id or `id#anchor`, e.g. `[§ 2.4](CFR:99-2.4)` or `[§ 2.2](CFR:99-2.2#guardrail-system)`. Tables are GFM.

`provenance.raw` paths point at `raw/cfr-title-99/2024-01-01/ECFR-title99.xml`, which does not exist in the repository yet; milestone C1 adds a synthetic raw XML so the round-trip validator can run against the fixture. Until then `raw_sha256` is a placeholder and `verified_by` is `[fixture]`.

`uv run --project proto sect-proto validate fixtures/corpus` checks the contract.
