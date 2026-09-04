# The ingest harness in a container (spec D.1: Pi has no sandbox, so ingest runs in one and the
# beforeToolCall hook gates writes to staging/). Build from the repository root:
#   docker build -f packages/sect-harness/Dockerfile -t sect-harness .
# Run with the corpus, raw documents, and staging mounted, and the key from .env in the environment:
#   docker run --rm --env-file .env -v "$PWD/corpora:/app/corpora" -v "$PWD/raw:/app/raw" \
#     -v "$PWD/work:/app/work" -v "$PWD/staging:/app/staging" sect-harness \
#     ingest --input work/ingest-input/cfr-title-4 --source cfr-title-4 --corpus corpora/ecfr

FROM rust:1-bookworm AS sect
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p sect-cli --locked

FROM node:22-bookworm-slim
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY examples ./examples
COPY docs ./docs
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @sectgrep/convert build \
  && pnpm --filter @sectgrep/harness build
COPY --from=sect /src/target/release/sect /usr/local/bin/sect
ENV SECT_BIN=/usr/local/bin/sect
VOLUME ["/app/staging", "/app/corpora", "/app/raw", "/app/work"]
ENTRYPOINT ["node", "packages/sect-harness/dist/cli.js"]
CMD ["ingest"]
