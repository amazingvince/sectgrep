#!/usr/bin/env bash
# Serve the C1 transcriber pair locally as two OpenAI-compatible vLLM servers: the primary
# (olmOCR-2-7B) on one GPU at :8000 and the secondary (GLM-OCR) on the other at :8001. Production
# points `sect-convert extract --ocr-server` at a hosted API instead; the boundary is the same.
# usage: serve-pair.sh [primary-gpu] [secondary-gpu]   (PCI bus order; default 0 and 1)
set -u
PG=${1:-0}
SG=${2:-1}
VENV="$HOME/venvs/vllm"
export PATH="$VENV/bin:$PATH" VLLM_WSL2_ENABLE_PIN_MEMORY=1 VLLM_USE_FLASHINFER_SAMPLER=0 CUDA_DEVICE_ORDER=PCI_BUS_ID
mkdir -p "$HOME/bakeoff"
CUDA_VISIBLE_DEVICES=$PG nohup "$VENV/bin/vllm" serve allenai/olmOCR-2-7B-1025 --port 8000 --host 0.0.0.0 \
  --gpu-memory-utilization 0.85 --trust-remote-code --max-model-len 16384 \
  > "$HOME/bakeoff/serve-olmocr.log" 2>&1 < /dev/null &
CUDA_VISIBLE_DEVICES=$SG nohup "$VENV/bin/vllm" serve zai-org/GLM-OCR --port 8001 --host 0.0.0.0 \
  --gpu-memory-utilization 0.6 --trust-remote-code --allowed-local-media-path / --max-model-len 16384 \
  --served-model-name zai-org/GLM-OCR glm-ocr \
  > "$HOME/bakeoff/serve-glmocr.log" 2>&1 < /dev/null &
echo "launched olmOCR-2 on GPU $PG (:8000) and GLM-OCR on GPU $SG (:8001); logs in ~/bakeoff/serve-*.log"
echo "ready when: curl -s localhost:8000/v1/models && curl -s localhost:8001/v1/models"
