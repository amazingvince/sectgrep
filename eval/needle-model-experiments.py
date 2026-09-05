"""Pinned CPU model experiments. No corpus publication, remote inference, or implicit truncation.

Run with the local WSL Python environment after needle-model-inputs.py. The experiment
compares the semantic leg and reranks the actual Rust hybrid shortlist; it does not
claim equivalence to a new integrated Rust hybrid engine or independent relevance.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import resource
import statistics
import time

EMBED = ("nomic-ai/modernbert-embed-base", "d556a88e332558790b210f7bdbe87da2fa94a8d8")
RERANK = ("cross-encoder/ms-marco-MiniLM-L6-v2", "233902d25c440f23af6f7d6e94d2946bac0bee0a")
PINS = {"torch": "2.14.0", "transformers": "5.16.1", "huggingface-hub": "1.30.0", "numpy": "2.5.2"}


def distribution(values):
    ordered = sorted(values)
    return {"samples": len(values), "p50_ms": statistics.median(values), "p95_ms": ordered[math.ceil(len(values) * .95) - 1]}


def windows(tokenizer, query, prefix, body, limit):
    """Cover every body character with bounded pair inputs, carrying structural context throughout."""
    overhead = len(tokenizer(query, prefix, truncation=False)["input_ids"])
    capacity = limit - overhead - 4
    if capacity < 32:
        raise ValueError("query/context leaves insufficient reranker body capacity")
    offsets = tokenizer(body, add_special_tokens=False, return_offsets_mapping=True, truncation=False)["offset_mapping"]
    if not offsets:
        return [(0, len(body), prefix + body)]
    out, token_start, covered = [], 0, 0
    while token_start < len(offsets):
        token_end = min(len(offsets), token_start + capacity)
        start = 0 if token_start == 0 else offsets[token_start][0]
        end = len(body) if token_end == len(offsets) else offsets[token_end][0]
        while len(tokenizer(query, prefix + body[start:end], truncation=False)["input_ids"]) > limit:
            token_end -= 1
            if token_end <= token_start:
                raise ValueError("reranker cannot fit a source window")
            end = offsets[token_end][0]
        if start > covered or end <= covered:
            raise ValueError("reranker window coverage did not advance")
        out.append((start, end, prefix + body[start:end]))
        covered = end
        if token_end == len(offsets):
            break
        token_start = token_end - min(32, max(1, (token_end - token_start) // 4))
    if covered != len(body):
        raise ValueError("reranker missed body tail")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=Path("review/needle-retrieval/model-experiments/inputs.json"))
    parser.add_argument("--work", type=Path, default=Path("review/needle-retrieval/model-experiments"))
    parser.add_argument("--output", type=Path, default=Path("eval/results/needle-model-experiments-2026-09-05.json"))
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()
    packages = {p: importlib.metadata.version(p) for p in PINS}
    if packages != PINS:
        raise RuntimeError(f"model experiment package pin mismatch: {packages}")
    import numpy as np
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    args.work.mkdir(parents=True, exist_ok=True)
    dataset = json.loads(args.inputs.read_text(encoding="utf8"))
    chunks, cases = dataset["chunks"], dataset["cases"]
    by_id = {c["chunk_id"]: c for c in chunks}
    inputs_hash = hashlib.sha256(args.inputs.read_bytes()).hexdigest()
    model_files = {}

    def materialize(spec):
        repo, revision = spec
        directory = Path(snapshot_download(repo, revision=revision, allow_patterns=["*.json", "*.txt", "*.safetensors"]))
        hashes = {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(directory.rglob("*")) if p.is_file()}
        model_files[repo] = {"revision": revision, "files_sha256": hashes}
        return directory

    print("Materializing pinned contextual model", flush=True)
    directory = materialize(EMBED)
    tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
    model = AutoModel.from_pretrained(directory, local_files_only=True, trust_remote_code=False, attn_implementation="sdpa").to("cpu").eval()
    maximum = model.config.max_position_embeddings
    texts = ["search_document: " + c["text"] for c in chunks]
    lengths = [len(tokenizer(t, truncation=False)["input_ids"]) for t in texts]
    if max(lengths) > maximum:
        raise ValueError("contextual model cannot cover existing passages; no truncation permitted")

    def encode(values):
        tokens = tokenizer(values, padding=True, truncation=False, return_tensors="pt")
        if tokens["input_ids"].shape[1] > maximum:
            raise ValueError("contextual model sequence overflow")
        with torch.inference_mode():
            output = model(**tokens).last_hidden_state
            mask = tokens["attention_mask"].unsqueeze(-1)
            pooled = (output * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
            return torch.nn.functional.normalize(pooled, dim=1).cpu().numpy()

    vectors_path = args.work / "modernbert-vectors.npy"
    cache_path = args.work / "modernbert-vectors.json"
    binding = {"inputs_sha256": inputs_hash, "model": EMBED, "packages": packages, "prefix": "search_document: ", "pooling": "masked mean including prompt; L2 normalize"}
    canonical_binding = json.loads(json.dumps(binding))
    started = time.perf_counter()
    if vectors_path.exists() and cache_path.exists() and json.loads(cache_path.read_text())["binding"] == canonical_binding:
        vectors = np.load(vectors_path)
        corpus_encode_ms = json.loads(cache_path.read_text())["corpus_encode_ms"]
    else:
        vectors = np.empty((len(chunks), model.config.hidden_size), dtype=np.float32)
        order = sorted(range(len(chunks)), key=lambda i: lengths[i])
        for begin in range(0, len(order), 8):
            selected = order[begin:begin + 8]
            vectors[selected] = encode([texts[i] for i in selected])
            if begin % 128 == 0:
                print(f"Embedded {begin}/{len(chunks)} passages; elapsed {time.perf_counter()-started:.1f}s", flush=True)
        corpus_encode_ms = (time.perf_counter() - started) * 1000
        np.save(vectors_path, vectors)
        cache_path.write_text(json.dumps({"binding": binding, "corpus_encode_ms": corpus_encode_ms}), encoding="utf8")
    embeddings = []
    embed_times = []
    for case in cases:
        q = "search_query: " + case["query"]
        encode([q])
        for _ in range(5):
            start = time.perf_counter()
            vector = encode([q])[0]
            embed_times.append((time.perf_counter() - start) * 1000)
        allowed = [i for i, c in enumerate(chunks) if c["source"] == case["source"]]
        scores = vectors[allowed] @ vector
        ranked = sorted(zip(allowed, scores.tolist()), key=lambda x: (-x[1], chunks[x[0]]["chunk_id"]))[:50]
        embeddings.append([{ "chunk_id": chunks[i]["chunk_id"], "cosine": score} for i, score in ranked])
    del model

    print("Materializing pinned shortlist reranker", flush=True)
    directory = materialize(RERANK)
    tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
    model = AutoModelForSequenceClassification.from_pretrained(directory, local_files_only=True, trust_remote_code=False).to("cpu").eval()
    maximum = model.config.max_position_embeddings
    comparisons = []
    rerank_times = {5: [], 10: [], 20: []}
    total_windows, split_passages, max_pair_tokens = 0, 0, 0
    for case, embedded in zip(cases, embeddings):
        shortlist = [h["chunk_id"] for h in case["rust"]["hybrid"][:20]]
        pairs, owners, ranges = [], [], []
        for cid in shortlist:
            chunk = by_id[cid]
            if not chunk["text"].endswith(chunk["body"]):
                raise ValueError("passage context/body contract changed")
            prefix = chunk["text"][:-len(chunk["body"])] if chunk["body"] else chunk["text"]
            pieces = windows(tokenizer, case["query"], prefix, chunk["body"], maximum)
            split_passages += len(pieces) > 1
            for start, end, text in pieces:
                pairs.append((case["query"], text))
                owners.append(cid)
                ranges.append({"chunk_id": cid, "body_start": start, "body_end": end, "offset_unit": "unicode_scalar"})
        counts = [len(tokenizer(q, p, truncation=False)["input_ids"]) for q, p in pairs]
        max_pair_tokens = max(max_pair_tokens, max(counts))
        total_windows += len(pairs)

        def rerank(count):
            selected_ids = set(shortlist[:count])
            rows = [i for i, cid in enumerate(owners) if cid in selected_ids]
            scores = {}
            for begin in range(0, len(rows), 8):
                batch = rows[begin:begin+8]
                tokens = tokenizer([pairs[i][0] for i in batch], [pairs[i][1] for i in batch], padding=True, truncation=False, return_tensors="pt")
                if tokens["input_ids"].shape[1] > maximum:
                    raise ValueError("reranker overflow; source window would truncate")
                with torch.inference_mode():
                    logits = model(**tokens).logits[:, 0].tolist()
                for i, score in zip(batch, logits):
                    scores[owners[i]] = max(scores.get(owners[i], -math.inf), score)
            return [{"chunk_id": cid, "score": score} for cid, score in sorted(scores.items(), key=lambda x: (-x[1], x[0]))]

        ranked = {}
        rerank(5)
        for count in rerank_times:
            for _ in range(3):
                start = time.perf_counter()
                ranked[str(count)] = rerank(count)
                rerank_times[count].append((time.perf_counter() - start) * 1000)
        record = {"query": case["query"], "source": case["source"], "rust": case["rust"], "modernbert_vector": embedded, "reranked_rust_hybrid": ranked, "source_windows": ranges}
        for target in case.get("targets", []):
            def rank(rows):
                return next((i+1 for i, row in enumerate(rows) if any(s["expr"] == target["expr"] for s in by_id[row["chunk_id"]]["spans"])), None)
            record.setdefault("diagnostic_targets", []).append({**target, "rust_hybrid_rank": rank(case["rust"]["hybrid"]), "rust_vector_rank": rank(case["rust"]["vector"]), "modernbert_rank": rank(embedded), "reranked_rank": rank(ranked["20"])})
        comparisons.append(record)
        print(f"Compared: {case['query']}", flush=True)
    result = {"purpose": "local CPU model diagnostics", "independently_judged": False, "generation": dataset["generation"], "inputs_sha256": inputs_hash,
              "packages": packages, "models": model_files, "device": "cpu", "threads": args.threads, "content_passages": len(chunks),
              "corpus_encode_ms": corpus_encode_ms, "max_contextual_input_tokens": max(lengths), "contextual_input_limit": 8192,
              "query_embedding_latency": distribution(embed_times), "reranker_latency": {str(k): distribution(v) for k, v in rerank_times.items()},
              "reranker_source_windows": total_windows, "reranker_split_passages": split_passages, "reranker_max_pair_tokens": max_pair_tokens,
              "implicit_truncations": 0, "peak_process_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
              "comparisons": comparisons,
              "limits": ["Seven diagnostic queries; no independent held-out accuracy.", "Python/PyTorch CPU timings are model-stage measurements, not an integrated Rust qualification.", "Reranker uses maximum over complete, overlapping source windows with the original structural prefix in every window.", "No parser, source text, model default or production corpus was changed by this experiment."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps({k: v for k, v in result.items() if k not in ["models", "comparisons"]}, indent=2), flush=True)


if __name__ == "__main__":
    main()
