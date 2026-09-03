#!/usr/bin/env bash
# Wait for the guarded api-paddle rerun to finish, then restart the Paddle sequence with the
# served-model alias its pipeline needs, and put the GLM-OCR and olmOCR chain behind it.
set -u
export PATH="$HOME/.local/bin:$PATH" UV_PROJECT_ENVIRONMENT="$HOME/venvs/bakeoff"
cd "$(dirname "$0")/.."
while pgrep -f '[b]akeoff run api-paddle --force' >/dev/null; do sleep 15; done
echo "rerun finished"
pkill -f '[c]hain-models.sh' 2>/dev/null
pkill -f '[r]un-model.sh' 2>/dev/null
pkill -f '[b]akeoff run sdk-paddle' 2>/dev/null
pkill -f '[b]akeoff run api-paddle' 2>/dev/null
uv run -q bakeoff stop
sleep 8
rm -rf ../../../raw/bakeoff/work/sdk-paddle
bash "$HOME/bakeoff/launch.sh" paddle
setsid nohup "$HOME/bakeoff/chain-models.sh" paddle glmocr olmocr > "$HOME/bakeoff/chain.log" 2>&1 < /dev/null &
echo "restarted"
