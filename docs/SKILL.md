# SKILL: answering questions with `sect`

You are answering questions about a corpus of rules (regulations, standards, guidelines) through seven `sect` verbs. Each verb is a tool named `sect_<verb>` over MCP and a subcommand on the command line; the arguments are identical. This file tells you which verb to reach for, what the answers look like, and where ranking stops and guarantees begin.

## Read the two header lines first

Every answer starts with a **freshness line** and a **counts line**.

```
freshness: fresh (44 files indexed; stat 2 ms; built 2026-09-03T16:29:01Z)
counts: 3 shown of 3 matched; 43 works, 44 expressions (1 superseded), 4 sources
```

- `fresh` means the metadata scan detected no outstanding changes. Same-size edits with restored timestamps can evade this scan; after such imports, run `sect index --full`. `possibly_stale (N changed)` means files changed and the answer came from the old index; say so if it matters, or ask again with `--freshness wait` on the CLI.
- `shown of matched` tells you whether the answer was bounded. If `matched` is larger than `shown`, narrow the question or use a complete verb (below) rather than assuming you saw everything.

## The seven verbs

| Need | Verb | Notes |
|---|---|---|
| A question in prose ("what height must a guardrail be") | `sect_search` | Hybrid ranking over distinct passages; legacy Markdown retains section-level result collapse. A citation (`99 CFR 2.8`, `§ 1.5(a)(2)`) or a definition question (`what is a hole`) is answered structurally and marked `pinned`. `expand: "refs"` appends the sections each hit cites. |
| An exact string or regex | `sect_grep` | Exhaustive and bounded: past `max_hits` (200) you get per-file counts and must narrow. ripgrep flags: `ignore_case`, `word`, `fixed_strings`, `glob`, `context`. `annotate: true` names the section and paragraph of each line. |
| The text of a section or passage | `sect_read` | Work id (`CFR:99-2.8`), Expression id (`CFR:99-2.8@2024-01-01`), `id#anchor` for one paragraph, or the passage address returned by search. Passage reads expand to complete canonical sections and include source locations. `as_of: "2025-06-01"` gives the text in force on that date; `history: true` lists every version and the notices between them; `ancestors: true` adds the chain above. Overlay markers (`> overridden-by`, `> narrowed-by`) appear inline: an overlay changes the rule locally, so read the overlay too. |
| What cites a section, or what it cites | `sect_refs` | `direction: "in"` for citers, `"out"` for citations, `type` to keep one edge kind (`references`, `overrides`, `narrows`, `supersedes`, `amends`, `defines`). Depth is capped at 5. This is a complete traversal, not a ranking. |
| A defined term | `sect_define` | The defining section and paragraph by structural resolution, with `usages: true` for the sections that use the term. If the term is not defined the answer says so; do not invent a definition. |
| The table of contents | `sect_map` | `scope` narrows to a Work or `id#anchor`; `complete: true` returns the whole subtree by traversal (every section under a part, every paragraph under a section). Use it when the question is "list all". |
| What the corpus contains | `sect_status` | Sources, counts, warnings, unresolved references, and the legal-status summary. Check it once at the start of a session and whenever a search abstains. |

## Ranking versus guarantees

`sect_search` ranks; it never promises completeness. When the question asks for *all* of something (every section that mentions X, every requirement under part Y, every citer of Z) use `sect_grep`, `sect_map` with `complete: true`, or `sect_refs`, which traverse and are complete within their bound. When search reports nothing above its confidence floor, say that it did not find a confident answer and name the nearest scope. That result alone does not establish that the corpus lacks an answer; inspect candidate sections or try exact terms when appropriate.

## Citing

Cite Work ids exactly as `sect` prints them (`CFR:99-2.8`, `CITY:AM-1`), with the anchor for a paragraph (`CFR:99-1.5#a-2`) and the Expression when the date matters (`CFR:99-2.7@2024-01-01`, "as of 2025-06-01"). Quote the text you rely on from `sect_read`, not from a search snippet. If a section is superseded or overridden, say which text you are quoting and why.

## Dates

Rules change. If the question names a date, pass `as_of` to `sect_search`, `sect_read`, `sect_refs`, and `sect_define`. Without a date you get the current text only; superseded Expressions are excluded unless the caller asked for them.

## A short session

1. `sect_status` to learn the sources and whether the index is fresh.
2. `sect_search` with the question; read the pinned or top hits.
3. `sect_read` the hit with `ancestors: true` (and `as_of` if dated) to quote the actual text and see overlay markers.
4. `sect_refs` with `direction: "in"` if the question is about what depends on the section, or `sect_define` if it turns on a term.
5. Answer with ids, quotes, and the date the text is in force. If the counts line says the answer was bounded, say what was left out.

## Seeding a session

`sect_search` with `seed: true` and `budget: N` returns a compact block of the most relevant sections under a token budget. Inject it once at the start of a long session instead of searching repeatedly for orientation.
