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
