#!/usr/bin/env bash
# Wait until the Paddle sequence and the Paddle pipeline rerun are both finished, then run the
# remaining models one after another on the GPU.
set -u
export PATH="$HOME/.local/bin:$PATH" UV_PROJECT_ENVIRONMENT="$HOME/venvs/bakeoff"
cd "$(dirname "$0")/.."
until grep -q "SEQUENCE DONE paddle" "$HOME/bakeoff/arm-paddle.log" 2>/dev/null; do sleep 20; done
while pgrep -f '[b]akeoff run sdk-paddle' >/dev/null; do sleep 20; done
echo "paddle finished"
for m in glmocr olmocr; do
  uv run -q bakeoff stop
  sleep 8
  "$HOME/bakeoff/run-model.sh" "$m" > "$HOME/bakeoff/arm-$m.log" 2>&1
done
uv run -q bakeoff stop
echo "CHAIN DONE"
