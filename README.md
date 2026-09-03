# sectgrep

`sect` is a single-binary search and navigation tool over a structured markdown corpus of rules and guidelines, built for AI agents: exact, lexical, semantic, and structural retrieval behind seven verbs (`search`, `grep`, `read`, `refs`, `define`, `map`, `status`) over CLI and MCP. This repository also holds `sect-convert` (preprocessing and validators) and the ingest harness that fills a corpus without ever writing to it directly.

**Status:** bootstrap and milestone 0 done (2026-09-03). The milestone-0 gate passed: locate Recall@5 0.95, definition 1.00 on the fixture (threshold 0.85), see [eval/results/m0.md](eval/results/m0.md). Next: milestone 0.5 (fork-or-borrow) and milestone 1 (Rust skeleton). Nothing is published yet.

- Roadmap and definition of done: [GOAL.md](GOAL.md)
- Specification: [sectgrep-spec-v0.4.md](sectgrep-spec-v0.4.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- Proposed spec changes: [docs/spec-changes.md](docs/spec-changes.md)

## Layout

```
crates/      Rust workspace for `sect` (empty until milestone 1)
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

The project name `sectgrep` and binary `sect` are provisional. The registry check is recorded in `docs/decisions.md` entry 14a; the final call is a human decision.

## License

Apache-2.0. See [LICENSE](LICENSE).
