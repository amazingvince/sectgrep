# Question set (spec E.1) for the fixture corpus

One JSONL file per question type. Every E.1 type is covered:

| File | Type | How it is scored |
|---|---|---|
| `locate.jsonl` | locate | Recall@5, NDCG@10, MRR on `gold` section ids |
| `id-lookup.jsonl` | id-lookup | exact-match: citation short-circuit puts `gold[0]` at rank 1 with `expected.anchor` |
| `definition.jsonl` | definition | Recall@5 (gate) and exact-match on the defining section and term anchor |
| `crossref.jsonl` | cross-ref | Recall@5 on the target; context Recall@5 over target + `context_required` with `--expand refs` |
| `subtree.jsonl` | subtree-completeness | exact-match: `map --complete` returns exactly `expected.expected` |
| `overlay.jsonl` | overlay | Recall@5 on the overlay and base section, plus exact-match on `overridden_by` / `narrowed_by` |
| `as-of.jsonl` | as-of | exact-match: snapped Expression, or the top hit of `search --as-of` |
| `amendment-history.jsonl` | amendment-history | exact-match on `read --history` / `refs --type amends`, or Recall@5 |
| `table.jsonl` | table | Recall@5 plus exact-match on the flattened table row lookup |
| `no-gold.jsonl` | no-gold | abstention accuracy (natural absence) |
| `wrong-corpus.jsonl` | wrong-corpus | abstention accuracy (Agent Retrieval Bench control: another corpus entirely) |
| `negative.jsonl` | negative | top hit is not the superseded Expression or the note in `must_not_top`; Recall@5 on gold |

## Schema

```json
{"qid": "loc-01", "type": "locate", "query": "...", "gold": ["CFR:99-2.4"], "as_of": null,
 "expected": {"op": "...", "...": "..."}, "context_required": ["..."], "must_not_top": ["..."],
 "generation": "hand | crawler", "notes": "..."}
```

`expected.op` is one of `map_complete`, `as_of`, `as_of_search`, `history`, `refs`, `overlay`, `table_lookup`. Gold and expected ids are Work ids (`CFR:99-2.7`) except where an Expression is meant (`CFR:99-2.7@2024-01-01`). `as_of_search` checks the Expression that `search --as-of` serves for the expected Work on that date; which Work ranks first is ranking, not the as-of guarantee.

## Cross-reference questions: the CRAwLeR recipe

1. **Detect explicit cross-references.** `sect-proto crossref-candidates` lists every section with markdown links to other sections: the referencing section is the target, the referenced sections are the required context.
2. **Write a query that is unanswerable from the target alone.** Done by the author (an LLM) into `crossref.jsonl`; each row records the target, the required context, and an `assurance` note saying why the target alone does not answer it.
3. **Adversarial filter.** `sect-proto filter` (also run inside `eval`) ranks each query with a non-contextual BM25 baseline and a non-contextual vector baseline over the body text only, and drops any question whose target is found at or above `--rank`. Results go to `crossref.filtered.jsonl` with both baseline ranks and a `kept` flag; `eval` scores only the kept questions and reports how many were dropped.
4. **Assurance.** Author-checked; recorded per question.

The spec's threshold is rank 10 for real corpora. The fixture uses `--rank 3` because the corpus has about 45 chunks, where rank 10 is the top quarter (see `docs/spec-changes.md` #5). Regenerate with:

```
uv run --project proto sect-proto filter fixtures/corpus --questions eval/questions --rank 3
```

Hand-written questions cover the other types. Everything refers to the synthetic Title 99 in `fixtures/corpus`; none of it is real law.

## Real titles

`ecfr/title1-queries.jsonl` holds 50 queries over the converted eCFR Title 1 (`corpora/ecfr`, built by `packages/sect-convert`): 45 locate, 2 id-lookup, 3 definition, each with an `expected` section as a hint for a human reader. Milestone 4 uses them for latency (`eval/eval_m4.py`); milestone 5 turns them into a gold-labelled set with the CRAwLeR recipe for cross-references.
