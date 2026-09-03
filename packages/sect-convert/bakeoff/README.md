# Milestone C0: extractor and OCR bake-off

Runs the layout orchestrators (Docling, Marker) and the permitted OCR VLMs (PaddleOCR-VL-1.5, GLM-OCR, olmOCR-2) over 30 documents and scores TextEdit, reading-order edit distance, and TEDS per document. The models are served locally by vLLM, one at a time on the RTX 5090; the layout tools run on the RTX 4090. Results land in `eval/results/c0.md`; the decision is in `docs/decisions.md`.

Two arms per VLM:

- `sdk-<model>`: the model's official pipeline pointed at the vLLM server (layout model plus per-element recognition where the pipeline has one).
- `api-<model>`: the converter's own path, one page image per request with the documented page prompt against the same server. This is what `packages/sect-convert/src/ocr/` does in production; the harness mirrors it in Python so it can run inside WSL2, and `sect-convert ocr --png` runs the TypeScript path itself against the same server for a spot check.

## Environment (WSL2, Ubuntu 24.04)

Docker is not installed in this WSL2, so each tool lives in a `uv` virtual environment under `~/venvs` (`vllm`, `docling`, `marker`, `olmocr`, `paddle`, `glmocr`, `bakeoff`). Weights are in the Hugging Face cache. Licenses checked before download: PaddleOCR-VL-1.5 Apache-2.0, GLM-OCR MIT, olmOCR-2-7B-1025 Apache-2.0; MinerU2.5 is AGPL-3.0 and was skipped.

```
export UV_PROJECT_ENVIRONMENT=$HOME/venvs/bakeoff
cd packages/sect-convert/bakeoff
uv run bakeoff prepare                 # manifest, golden files from the granule XML, page PDFs
uv run bakeoff run docling             # layout arms need no server
uv run bakeoff run marker
uv run bakeoff serve olmocr            # vLLM on the 5090; waits until /v1/models answers
uv run bakeoff run api-olmocr
uv run bakeoff run sdk-olmocr
uv run bakeoff run api-olmocr --long-side 1024 --tag api-olmocr-1024 --group born   # scaling sweep
uv run bakeoff stop
...                                    # glmocr, paddle the same way
uv run bakeoff consensus               # golden for the scanned pages from the transcribers' agreement
uv run bakeoff score
uv run bakeoff report                  # eval/results/c0.md
```

`scripts/run_all.sh` runs the whole sequence.

## Documents

- `born`: 10 Title 29 granules (2024 annual edition PDF from the GovInfo link service, XML of the same edition as ground truth), 2 pages each.
- `table`: 10 granules with GPOTABLE tables; TEDS against the HTML built from the XML.
- `scan`: 10 pages from the 1975-03-03 and 1985-06-03 Federal Register issues (100 DPI scans, no text layer). Ground truth is the line-level consensus of the transcribers, with unconfirmed lines flagged `(?)` in `eval/golden/bakeoff/scan/*.md` for a hand check; scan scores measure agreement with that consensus and favour the arms that formed it.

## Scoring

`bakeoff/score.py`: the model output is clipped to the section's span (a printed page carries neighbouring sections and running heads), markdown syntax and tables are stripped on both sides, and TextEdit is the normalized Levenshtein distance. Reading order locates each golden block in the output by fuzzy partial match and takes the normalized edit distance between the emitted order and the golden order. TEDS pairs tables in document order and uses APTED with cell-text rename costs.

## What the environment required (recorded so the next run is not a rediscovery)

- vLLM 0.28 on WSL2: it disables pinned host memory when it detects WSL and then fails to build its UVA buffers ("UVA is not available"). Pinned memory works on this kernel (6.18), and vLLM's own switch `VLLM_WSL2_ENABLE_PIN_MEMORY=1` turns it back on; the harness sets it.
- The FlashInfer top-k/top-p sampler is compiled just-in-time for the RTX 5090; greedy decoding never needs it, so `VLLM_USE_FLASHINFER_SAMPLER=0` keeps start-up under a minute. The GPU is pinned by `CUDA_DEVICE_ORDER=PCI_BUS_ID` because CUDA's default order lists the 4090 first.
- Marker 2.0's balanced mode drives Surya's VLM through a Docker-spawned vLLM; the arm runs `--mode fast --disable_multiprocessing` with a 600 s timeout per document (the multiprocess path hung on one granule). Docker Desktop's WSL integration was enabled part-way through the milestone; the environments stayed as `uv` venvs.
- Docling's markdown export inlines page images as base64; the scorer strips them.
- PaddleOCR-VL-1.5 given a whole page and the "OCR:" prompt loops on table cells until the token cap (13 of 30 documents on the first pass). Its recognition head expects element crops from its layout stage, which is what the `sdk-paddle` arm does. The `api` arms and the converter's transcriber carry a repetition guard: a degenerate reply is retried once with `frequency_penalty` 0.5 and a 4096-token cap and flagged if it persists.
