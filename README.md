# sectgrep

`sect` is a single-binary search and navigation tool over a structured markdown corpus of rules and guidelines, built for AI agents: exact, lexical, semantic, and structural retrieval behind seven verbs (`search`, `grep`, `read`, `refs`, `define`, `map`, `status`) over CLI and MCP. This repository also holds `sect-convert` (preprocessing and validators) and the ingest harness that fills a corpus without ever writing to it directly.

**Status:** milestones 0, 0.5, 1, 2, and 3 done (2026-09-03). `sect grep` runs on ripgrep's crates with rg-compatible flags and output; 28 parity cases match ripgrep 14.1.1 byte for byte ([eval/results/m3.md](eval/results/m3.md)). The milestone-0 gate passed (locate Recall@5 0.95, definition 1.00, [eval/results/m0.md](eval/results/m0.md)); the fork-or-borrow decision is in [docs/decisions.md](docs/decisions.md) 15a; the Rust binary indexes the fixture into `tree.json`, `xrefs.jsonl`, `actions.jsonl`, `terms.json`, and `tables.jsonl`, and answers `read`, `map`, `refs`, `define`, and `status`, with `--as-of` snapping, `--history`, `map --complete`, and overlay markers inline. Exact-match on the fixture is 1.00 for refs, define, as-of, and map --complete ([eval/results/m2.md](eval/results/m2.md)). Next: milestone 4 (lexical and semantic `search`), C0 and C1 on the converter track. Nothing is published yet.

## Build and run

```
cargo build --release
target/release/sect index fixtures/corpus
target/release/sect read CFR:99-2.7 --corpus fixtures/corpus --ancestors
target/release/sect map --scope CFR:99-2 --depth 1 --corpus fixtures/corpus
target/release/sect status --corpus fixtures/corpus
target/release/sect index --validate-only fixtures/corpus
target/release/sect refs CFR:99-2.8 --direction in --corpus fixtures/corpus
target/release/sect refs CFR:99-2.7 --direction in --type references --as-of 2025-06-01 --corpus fixtures/corpus
target/release/sect define "qualified person" --usages --scope CFR:99-2 --corpus fixtures/corpus
target/release/sect map --complete --scope "CFR:99-2.13#c" --corpus fixtures/corpus
target/release/sect read CFR:99-2.7 --history --as-of 2025-06-01 --corpus fixtures/corpus
target/release/sect read "CFR:99-1.4#b" --corpus fixtures/corpus
target/release/sect grep -i -w "cage" -C 1 --corpus fixtures/corpus
target/release/sect grep --annotate "48 inches" --corpus fixtures/corpus
target/release/sect grep -c employer --scope CFR:99-3 --corpus fixtures/corpus
target/release/sect grep "the" --max-hits 50 --corpus fixtures/corpus     # over the bound: per-file counts and a note
```

`grep` takes the common ripgrep flags (`-i -w -F -e -g -n -N -c -l -A -B -C`) and prints what ripgrep prints, after the two header lines. It is exhaustive and bounded: past `--max-hits` (default 200) it answers with per-file counts and asks you to narrow.

Every answer starts with a freshness line and a counts line. `--json` puts `freshness` and `counts` first. A query on a changed corpus rebuilds the index first and says so; `--no-refresh` answers from the index as it is and says `possibly_stale`.

- Roadmap and definition of done: [GOAL.md](GOAL.md)
- Specification: [sectgrep-spec-v0.4.md](sectgrep-spec-v0.4.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- Proposed spec changes: [docs/spec-changes.md](docs/spec-changes.md)

## Layout

```
crates/      Rust workspace for `sect`: sect-core, sect-corpus, sect-struct, sect-index, sect-query,
             sect-format, sect-cli (real); sect-exact, sect-ngram, sect-lexical, sect-semantic,
             sect-rank, sect-mcp (stubs naming their milestone)
packages/    sect-convert and the ingest harness (TypeScript; from milestone C1)
proto/       Milestone-0 Python prototype (semble); throwaway, never shipped
eval/        Question sets, golden data, and per-milestone results
fixtures/    Synthetic corpus for CI (spec B.2 contract)
docs/        Decisions, spec-change proposals, agent SKILL files
```

## Milestone-0 prototype

```
uv sync --project proto
uv run --project proto sect-proto validate fixtures/corpus
uv run --project proto sect-proto eval --corpus fixtures/corpus --questions eval/questions --out eval/results/m0.md --gate 0.85 --filter-rank 3
```

See [proto/README.md](proto/README.md).

## Name

The project and crate are `sectgrep`; the binary is `sect`. `sect` alone is taken on crates.io by an unrelated library, so install with `cargo install sectgrep` once R1 is published. The registry check and the decision are in `docs/decisions.md` entry 14a.

## License

Apache-2.0. See [LICENSE](LICENSE).
