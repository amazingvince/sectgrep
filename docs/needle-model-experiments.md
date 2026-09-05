# Contextual embeddings and bounded reranking

Measured on 2026-09-05. Keep the fast model as the default for now. A contextual
embedding model is promising on the inspected examples; this small experiment
does not establish independently judged retrieval quality. The 20-candidate
reranker already exceeds the 500 ms warm-query target in its model stage alone.

The experiment uses the same 3,777 content passages from document-store generation
`01788591462672109700`, seven diagnostic queries, and the actual Rust hybrid,
lexical and vector shortlists. It changes neither source text nor passage policy.
Three queries exercise generated Office, spreadsheet and JSON fixtures. The four
real-source queries remain development examples, not held-out labels.

## Models and measurements

| Component | Measured CPU work | Result |
| --- | --- | --- |
| Nomic ModernBERT Embed Base | Encode all 3,777 passages, batches of eight | 470.4 seconds, excluding download/model startup |
| Nomic query embedding | 35 warmed measurements | p50 22.2 ms; p95 25.5 ms |
| MiniLM cross-encoder, up to 5 candidates | 21 warmed measurements | p50 106.0 ms; p95 182.1 ms |
| MiniLM cross-encoder, up to 10 candidates | 21 warmed measurements | p50 120.1 ms; p95 351.2 ms |
| MiniLM cross-encoder, up to 20 candidates | 21 warmed measurements | p50 416.9 ms; p95 664.4 ms |

These are serial Python/PyTorch model-stage measurements on the local WSL CPU with
eight threads, float32 inference and no GPU. They are not end-to-end Rust latency
or Windows/Linux scale qualification. The short fixture corpus supplies fewer
candidates than some budgets; the JSON preserves the actual candidate lists.
Peak process RSS was 1,937,571,840 bytes across both model phases, including runtime
allocators. It is not an integrated Rust query memory measurement.

[Nomic's model card](https://huggingface.co/nomic-ai/modernbert-embed-base) specifies
768-dimensional embeddings and separate `search_document:`/`search_query:` prefixes.
The pinned configuration permits 8,192 tokens. The implementation follows the
published Transformer, masked mean pooling and normalization modules. Maximum
observed input was 1,024 tokens under its tokenizer; the passage policy itself was
compiled using the existing model's tokenizer.

[MiniLM's model card](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)
describes a passage-ranking cross-encoder trained on MS MARCO. Its pinned model has
a 512-token pair limit. Automatic truncation would omit source evidence, so the
experiment covers every candidate body character with overlapping windows and
carries the structural prefix in each window. It scores a passage by its highest
window score. There were 118 windows, 26 split candidate occurrences, a maximum of
508 input tokens and zero implicit truncations. Maximum aggregation is itself an
experimental choice and can favor passages with more windows.

## What the inspected rankings show

- The FHA TOTAL and Manual clauses remain in the top five across the compared
  methods. Hybrid ranks their containing passages first and second; contextual
  vectors also rank them first and second. Reranking moves TOTAL to fourth and
  Manual to first, while promoting definition passages. A larger model does not
  automatically improve this scope distinction.
- For the Fannie income-documentation query, contextual vectors and reranking
  place the “Verification of Income” passage first. The reference hybrid places
  the introductory passage first. This is a useful candidate for blind review.
- All compared methods put the Attention paper's “Scaled Dot-Product Attention”
  passage first. They do not repair the known mathematical extraction defects.
- On the generated `nova-079` query, contextual vectors and reranking put the
  named JSON record first; reference hybrid puts the related archive rules first.
  Preserve an exact identifier route when evaluating fusion, rather than assuming
  semantic ranking will always select the record.

Ranks refer to the passage containing the source span. A merged passage's first
section title can differ from the particular member that answered the query. The
experiment stores source membership, not invented relevance labels.

## Reproduce

```powershell
python eval/needle-model-inputs.py --binary review/needle-retrieval/sect-pre-navigation.exe
wsl -d Ubuntu-24.04-CUDA -- /home/amazi/venvs/docling/bin/python /mnt/c/Users/amazi/code/sect/eval/needle-model-experiments.py
```

The script requires the package versions recorded in its `PINS` constant. Model
downloads are local assets; inference has no service dependency and executes no
remote model code.

The preserved baseline executable has SHA-256
`899a31995c9ff4f695831589240cf86a2801979cb73b289413789566fb78102e`.
Use a different output directory when comparing a later binary so the frozen inputs
and vector cache remain inspectable.

The model repository revisions are:

- `nomic-ai/modernbert-embed-base`: `d556a88e332558790b210f7bdbe87da2fa94a8d8`
- `cross-encoder/ms-marco-MiniLM-L6-v2`: `233902d25c440f23af6f7d6e94d2946bac0bee0a`

[The result artifact](../eval/results/needle-model-experiments-2026-09-05.json)
records model-file hashes, input binding, raw rankings, window ranges and timings.
Do not benchmark during extraction, compilation or another benchmark.

Next, label source answers independently and compare an integrated contextual
semantic leg plus existing global lexical/exact retrieval. Keep the reranker
optional and measure a smaller shortlist before accepting its latency. No default
model switch is supported by seven development queries.
