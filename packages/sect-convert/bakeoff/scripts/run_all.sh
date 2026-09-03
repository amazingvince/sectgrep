#!/usr/bin/env bash
# The whole bake-off, one model on the GPU at a time. Run from WSL2 after the environments exist.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH" UV_PROJECT_ENVIRONMENT="$HOME/venvs/bakeoff"
cd "$(dirname "$0")/.."
LOG="$HOME/bakeoff"; mkdir -p "$LOG"
run() { echo "== $*" ; uv run -q bakeoff "$@"; }

run prepare
run run docling || true
run run marker || true
for model in olmocr glmocr paddle; do
  run serve "$model"
  run run "api-$model" || true
  run run "sdk-$model" || true
  # Scaling sweep on the born-digital group: does the model's own target beat smaller and larger?
  for side in 1024 1288 1540 2048; do
    run run "api-$model" --group born --long-side "$side" --tag "api-$model-$side" || true
  done
  run stop
done
run consensus
run score
run report
echo "done: eval/results/c0.md"
