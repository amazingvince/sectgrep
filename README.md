# sectgrep

`sect` searches and navigates complex document corpora: underwriting guidelines,
research papers, regulations and other collections where the answer depends on
definitions, exceptions and related sections. It combines exact matching, lexical
search, local embeddings and structural relationships in a Rust binary, available
through the CLI and MCP.

The goal is to find a useful passage quickly, then follow its evidence back to the
source. Source regions, canonical sections and retrieval passages are separate:
small extraction units do not have to become tiny search results.

**Experimental.** The implementation has automated regression coverage and recorded
Windows/Linux performance diagnostics. Independent extraction and relevance
judgments remain incomplete; arbitrary-format accuracy and semantic knowledge-graph
quality are not established. See [validation and limitations](#validation-and-limitations).

## Quick start

Install Rust through rustup; [rust-toolchain.toml](rust-toolchain.toml) pins the
toolchain. Run these commands from the repository root. On Windows, use
`target/release/sect.exe` for the executable.

```sh
cargo build --release --locked
target/release/sect index fixtures/corpus --embedding none
target/release/sect search "fixed ladder cage requirement" --corpus fixtures/corpus --fts
target/release/sect read CFR:99-2.7 --corpus fixtures/corpus --ancestors
target/release/sect grep -F "48 inches" --corpus fixtures/corpus
target/release/sect status --corpus fixtures/corpus
```

This indexes the included synthetic corpus without downloading an embedding model.
To enable semantic search, rebuild with the default model:

```sh
target/release/sect index fixtures/corpus --full --embedding model2vec:minishlab/potion-retrieval-32M
target/release/sect search "toeboard height at a guardrail" --corpus fixtures/corpus
```

The default is Model2Vec `potion-retrieval-32M`, downloaded from Hugging Face during
indexing and stored with the generation. Search then runs locally without a hosted
model or API key. Build dependencies and the initial model download require network
access. Release binaries and registry packages are not published by this repository.

## Search and navigation

| Verb | Use it to |
| --- | --- |
| `search` | Rank passages using lexical/vector retrieval, citation routing and optional related evidence. |
| `grep` | Find exact text or regex matches, with ripgrep-style flags, scopes and exhaustive counts. |
| `read` | Open a section, revision or passage with its canonical text and source locations. |
| `refs` | Follow incoming/outgoing references and typed relationships. |
| `define` | Resolve definitions within a scope and inspect their usages. |
| `map` | Browse the document hierarchy. |
| `status` | Inspect corpus coverage, index state and freshness. |

Add `--json` for structured output. Responses include freshness and counts. Use
`sect <verb> --help` for the full contract, or the [agent guide](docs/SKILL.md) for
choosing a verb.

```sh
target/release/sect search "ladders and fall protection" --expand refs --corpus fixtures/corpus
target/release/sect search "guardrail" --fts --scope CFR:99-2 --corpus fixtures/corpus
target/release/sect define "qualified person" --usages --scope CFR:99-2 --corpus fixtures/corpus
target/release/sect refs CFR:99-2.8 --direction in --corpus fixtures/corpus
target/release/sect read CFR:99-2.7 --history --as-of 2025-06-01 --corpus fixtures/corpus
```

Search fuses Tantivy BM25 and local vector results, with source/scope/revision
filters. Citation-shaped queries can route directly to a section. The passage
compiler groups compatible units, preserves source spans and attaches scoped
support such as table headers. Its limits use the model's actual tokenizer when
embeddings are enabled, and word counts with `--embedding none`.
`read` expands a passage into its complete canonical sections.

An optional sparse n-gram index accelerates `grep` by pruning impossible files;
the matcher still verifies candidates. `index --ngram on` enables it explicitly,
and `grep --no-index` provides the exhaustive comparison path. Broad grep output
is bounded; beyond `--max-hits`, it reports per-file counts and asks for narrowing.

## Use from an agent

```sh
target/release/sect serve --corpus fixtures/corpus
target/release/sect serve --corpus fixtures/corpus --http 127.0.0.1:7999
target/release/sect install --corpus fixtures/corpus --project --dry-run
```

`serve` exposes the seven verbs over stdio by default, or loopback HTTP at `/mcp`.
CLI and MCP share argument definitions and result structures. `install` copies the
binary and registers it with supported clients; inspect its dry run first.
The [Pi example](examples/pi) and [Claude Agent SDK example](examples/claude-agent-sdk)
show integrations. Their tool tests do not require an API key.

## Bring your own documents

The TypeScript converter supports PDF, DOCX, HTML, XLSX/CSV/TSV, PPTX,
Markdown/text, XML and JSON. Format support describes available adapters, not a
guarantee of faithful extraction for every layout.

Install Node.js 22+ and the pnpm version pinned in [package.json](package.json):

```sh
pnpm install --frozen-lockfile
pnpm -r build
node packages/sect-convert/dist/cli.js ingest-file --input path/to/paper.pdf --out corpora/papers --source research --id paper-001 --effective 2026-09-05
target/release/sect index corpora/papers --embedding none
target/release/sect search "your question" --corpus corpora/papers --fts
```

Choose a stable document ID and an effective date appropriate to the source.
Ingestion retains raw-file hashes, native source locations, document structure and
identity information alongside canonical sections. Existing structured Markdown
corpora remain supported. Opt-in [document bundles](docs/document-store-implementation.md)
store those sections together while preserving their addresses.

For larger collections, the [creation pipeline and review app](docs/corpus-creation-implementation.md)
provide resumable stages, bounded enrichment, source review, verification and
publication. [Knowledge profiles](profiles) define domain vocabulary; claims carry
evidence, scope and verification state. The recorded public pilot has no accepted
semantic relations, so graph usefulness still needs independent validation.

Hosted enrichment and OCR use explicitly configured providers and endpoints; see
[.env.example](.env.example). A provider key alone does not enable secondary OCR.
Unverified scanned text cannot publish through `ingest-file`. Raw corpora, local
review state, model caches and secrets are excluded from Git.

## Indexing and freshness

Indexes publish immutable generations under `.sect/`. Incremental builds reuse
parsed inputs, [compiled passages with unchanged dependencies](docs/compiled-passage-cache.md),
and unchanged lexical/vector entries. Structural, snapshot and n-gram stages still
have work proportional to corpus size.

Queries check tracked file sizes and modification times. By default, up to 20
detected changes refresh synchronously; larger changes trigger a background rebuild
and the response reports possible staleness. `SECT_SYNC_LIMIT` changes that boundary.
`--freshness wait` waits for detected changes; `--freshness no` uses the saved index.

A same-size edit with its original timestamp restored can evade detection, including
with `--freshness wait`. After imports that preserve those metadata, run
`sect index --full CORPUS` to verify content and rebuild.

## Validation and limitations

Start with the [contributor checks](CONTRIBUTING.md), which run on the included
fixtures. CI builds and tests the Rust/TypeScript workspaces on Windows and Linux
and checks all four Rust-owned schema/TypeScript contracts.

The [evaluation guide](eval/README.md) distinguishes fixture checks, frozen-corpus
diagnostics and independent quality qualification. Recorded scale runs cover
45,320 canonical sections and 117,075 passages from three regulatory titles. They
measure fixed diagnostic queries, not held-out retrieval accuracy; the Windows
process-cold p95 was close to the two-second target. See the
[scale report](docs/needle-scale-implementation.md) for exact runs, bindings and limits.

Open work includes independently judged extraction/relevance tests, PDF math and
reading order, complex Office/table layouts, reversible source normalization,
native eCFR appendix coverage, semantic-relation quality, and large-update time and
memory. The [review walkthrough](docs/validation-walkthrough.md) explains how to
judge source fidelity and whether retrieved evidence actually answers a question.

## Repository

| Directory | Contents |
| --- | --- |
| `crates/` | Rust corpus, indexing, retrieval, ranking, CLI and MCP implementations. |
| `packages/sect-convert/` | Native extraction, document contracts and validators. |
| `packages/sect-harness/` | Ingestion, verification, publication and review services. |
| `packages/sect-review/` | Local source and benchmark review UI. |
| `profiles/` | Generic and domain-specific knowledge profiles. |
| `fixtures/` | Synthetic corpora and source fixtures used by tests. |
| `eval/` | Evaluation runners, source locks and recorded results. |
| `docs/` | Architecture, implementation evidence, plans and agent guides. |
| `proto/` | Historical Python prototype; not part of the shipped binary. |

Use the [documentation index](docs/README.md) to navigate current implementation
reports and historical decisions. The [original specification](sectgrep-spec-v0.4.md)
is retained unchanged; later plans describe the passage and document-store changes.

Licensed under [Apache-2.0](LICENSE).
