# Development and validation

Run commands from the repository root. Rustup uses the pinned Rust 1.92.0 toolchain;
the TypeScript workspace requires Node.js 22+ and pnpm 10.27.0. Python 3.11+ runs the
standard-library evaluation tests. Install ripgrep for the exact-search parity tests.

## Build and test

```sh
pnpm install --frozen-lockfile
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --workspace --locked
cargo run -p sect-cli --locked -- index fixtures/corpus --embedding model2vec:minishlab/potion-retrieval-32M
cargo test --workspace --locked
pnpm -r build
pnpm -r test
python -m unittest discover -s eval -p "test_*.py"
cargo run -p sect-cli --locked -- index --validate-only fixtures/corpus
```

The model warmup downloads the default embedding model on first use. These tests do
not need hosted-model keys. Tests that require a local real corpus skip when it is
absent; a green fixture suite alone is not real-corpus qualification.

The TypeScript integration tests need the built Rust executable. If it is not found
automatically, set `SECT_BIN` to its absolute path before testing:

```powershell
$env:SECT_BIN = (Resolve-Path target/debug/sect.exe).Path
```

```sh
export SECT_BIN="$PWD/target/debug/sect"
```

Finish Rust builds before running the TypeScript integration suite, especially on
Windows where a running executable can prevent relinking. Run performance
measurements separately from builds, tests and other corpus work.

## Contract changes

Rust owns four contracts: `knowledge`, `document`, `identity` and `sections`.
Change their Rust definitions, regenerate each corresponding schema, then regenerate
the TypeScript interfaces. For example, in a UTF-8 shell (PowerShell 7 on Windows):

```sh
cargo run -p sect-core --locked --example knowledge_schema > docs/knowledge.schema.json
cargo run -p sect-core --locked --example document_schema > docs/document.schema.json
cargo run -p sect-core --locked --example identity_schema > docs/identity.schema.json
cargo run -p sect-core --locked --example sections_schema > docs/sections.schema.json
node packages/sect-convert/scripts/generate-contract.mjs
```

Commit schemas and generated interfaces together. CI regenerates all four pairs and
rejects drift. Do not edit generated types by hand.

## Corpus and evaluation changes

Keep source fixtures small and synthetic or appropriately licensed. Real acquired
sources, indexes, model caches, extraction work and review state stay in the ignored
local directories. Commit acquisition locks, reproducible scripts and bounded
evidence reports; see [the evaluation guide](eval/README.md).

Preserve historical source hashes and generation bindings. Record new experiments
under new output names instead of overwriting old measurements. Keep parser fidelity,
mechanical consistency, latency and independently judged relevance claims separate.

The original [v0.4 specification](sectgrep-spec-v0.4.md) remains a historical contract.
Describe changes in the [implementation reports and plans](docs/README.md), with
tests appropriate to the changed behavior and explicit compatibility limitations.
