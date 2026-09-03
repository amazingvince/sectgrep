#!/usr/bin/env bash
# Kill a stuck layout arm and start it again (it resumes from the documents already written).
# usage: relaunch-arm.sh <docling|marker>
set -u
ARM=$1
export PATH="$HOME/.local/bin:$PATH" UV_PROJECT_ENVIRONMENT="$HOME/venvs/bakeoff"
case "$ARM" in
  marker) pkill -f '[m]arker_single' 2>/dev/null ;;
  docling) pkill -f '[v]envs/docling/bin/docling' 2>/dev/null ;;
esac
pkill -f "[b]akeoff run $ARM" 2>/dev/null
sleep 2
cd "$(dirname "$0")/.."
nohup uv run -q bakeoff run "$ARM" > "$HOME/bakeoff/arm-$ARM.log" 2>&1 < /dev/null &
sleep 2
echo "relaunched $ARM"
