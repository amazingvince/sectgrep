"""Measure a frozen real corpus with default freshness, without manufacturing relevance labels.

Run serially after indexing, with no compilation, extraction or other benchmark running.
"""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time
from qualification import Mcp

CASES = [
    {"query": "hazardous waste accumulation time limits"},
    {"query": "vehicle evaporative emission test procedures", "source": "cfr-title-40"},
    {"query": "good manufacturing practice sanitation food contact"},
    {"query": "electronic records audit trail", "source": "cfr-title-21"},
    {"query": "medical device quality system records"},
    {"query": "research experimental expenditures", "source": "cfr-title-26"},
    {"query": "controlled foreign corporation subpart F income"},
    {"query": "qualified retirement plan required minimum distributions"},
    {"query": "40 CFR 261.4"},
    {"query": "21 CFR 11.10"},
    {"query": "26 CFR 1.61-1"},
    {"query": "recordkeeping reporting requirements"},
]


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def generation(corpus):
    return corpus / ".sect/generations" / sorted((corpus / ".sect/published").glob("*.ready"))[-1].stem


def inventory(corpus):
    directory = generation(corpus)
    manifest = load(directory / "manifest.json")
    counts = Counter()
    sources = Counter()
    hashes = set()
    max_tokens = 0
    with (directory / "chunks.jsonl").open(encoding="utf8") as lines:
        for line in lines:
            chunk = json.loads(line)
            nav = chunk["navigation"]
            counts["navigation" if nav else "content"] += 1
            if not nav:
                sources[chunk["source"]] += 1
                hashes.add(hashlib.sha256(chunk["body"].encode("utf8")).digest())
                counts["content_below_20_words"] += len(chunk["body"].split()) < 20
            max_tokens = max(max_tokens, chunk["token_count"])
    counts["distinct_content_body_hashes"] = len(hashes)
    fingerprints = load(directory / "fingerprints.json")
    return {"generation": directory.name, "manifest": manifest, "passages": counts,
            "content_by_source": sources, "max_recorded_input_tokens": max_tokens,
            "tracked_inputs": len(fingerprints["files"]), "tracked_directories": len(fingerprints["dirs"]),
            "hashes": {name: digest(directory / name) for name in ["manifest.json", "chunks.jsonl", "vectors.bin", "sources.json"]},
            "preparation": load(corpus / ".work/scale-preparation.json")}


def distribution(values):
    return {"samples": len(values), "p50_ms": statistics.median(values),
            "p95_ms": sorted(values)[math.ceil(len(values) * .95) - 1], "max_ms": max(values)}


def search(session, arguments):
    response = session.request("tools/call", {"name": "sect_search", "arguments": arguments})
    if response.get("isError"):
        raise RuntimeError(response)
    envelope = response["structuredContent"]
    if envelope["freshness"]["state"] != "fresh":
        raise ValueError("MCP returned stale evidence")
    return envelope["result"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--warm-repeats", type=int, default=5)
    parser.add_argument("--cold-repeats", type=int, default=2)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("result already exists; preserve it and choose a new output")
    if args.warm_repeats < 1 or args.cold_repeats < 1:
        parser.error("positive repetition counts required")
    if os.environ.get("SECT_FRESHNESS_WATCH") == "1":
        raise ValueError("disable the optional notification shortcut for this benchmark")
    binary, corpus = args.binary.resolve(), args.corpus.resolve()
    before = inventory(corpus)
    print(json.dumps({"phase": "inventory", "passages": before["passages"], "tracked_inputs": before["tracked_inputs"]}), flush=True)
    if before["passages"]["content"] < 100000:
        raise ValueError("fewer than 100k real content passages; do not relabel or duplicate sources to pass")
    if set(before["content_by_source"]) != {"cfr-title-21", "cfr-title-26", "cfr-title-40"}:
        raise ValueError("unexpected source selection")
    for source in load("eval/corpora/needle-scale.lock.json")["sources"]:
        if digest(corpus / f"cfr-title-{source['title']}/raw.xml") != source["sha256"]:
            raise ValueError("source acquisition binding changed")
    rows = [{**case, "warm_ms": [], "cold_ms": []} for case in CASES]
    session = Mcp(binary, corpus, freshness=None)
    try:
        for row in rows:
            row["result"] = search(session, {**{k: row[k] for k in ("query", "source") if k in row}, "limit": 5})
        if generation(corpus).name != before["generation"]:
            raise ValueError("warmup rebuilt a stale corpus; prepare a fresh index before measuring")
        print("Warmup complete.", flush=True)
        for repeat in range(args.warm_repeats):
            for row in rows:
                command = {**{k: row[k] for k in ("query", "source") if k in row}, "limit": 5}
                start = time.perf_counter()
                result = search(session, command)
                row["warm_ms"].append((time.perf_counter() - start) * 1000)
                if result != row["result"]:
                    raise ValueError("warm result changed")
            print(f"Warm pass {repeat + 1} complete.", flush=True)
        rss = session.peak_rss()
    finally:
        session.close()
    for repeat in range(args.cold_repeats):
        for row in rows:
            command = [str(binary), "--corpus", str(corpus), "search", row["query"], "--limit", "5", "--json"]
            if "source" in row:
                command += ["--source", row["source"]]
            start = time.perf_counter()
            completed = subprocess.run(command, capture_output=True, encoding="utf8", timeout=180, check=True)
            row["cold_ms"].append((time.perf_counter() - start) * 1000)
            response = json.loads(completed.stdout)
            if response["freshness"]["state"] != "fresh" or response["result"] != row["result"]:
                raise ValueError("cold CLI and warm MCP freshness/results differ")
        print(f"Process-cold pass {repeat + 1} complete.", flush=True)
    if generation(corpus).name != before["generation"]:
        raise ValueError("generation changed during benchmark")
    if any(digest(generation(corpus) / name) != sha for name, sha in before["hashes"].items()):
        raise ValueError("immutable generation artifacts changed")
    warm = distribution([v for row in rows for v in row["warm_ms"]])
    cold = distribution([v for row in rows for v in row["cold_ms"]])
    result = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "purpose": "real regulatory-corpus scale measurement; no relevance qualification",
              "environment": {"platform": platform.platform(), "processor": platform.processor(), "python": platform.python_version(),
                              "binary_sha256": digest(binary), "default_freshness": True},
              "index": before, "warm_mcp": warm, "process_cold_cli": cold, "peak_mcp_rss_bytes": rss,
              "performance_gates": {"warm_p95_500ms": warm["p95_ms"] <= 500, "cold_p95_2000ms": cold["p95_ms"] <= 2000,
                                    "rss_under_2gib": rss is not None and rss < 2 * 1024 ** 3},
              "rows": rows, "limits": ["Three regulatory XML titles; no multi-format or domain relevance qualification.",
                                           "Process-cold includes startup; OS page cache is uncontrolled.",
                                           "Effective dates identify the recorded acquisition-day snapshot, not legal commencement; no historical accuracy claim.",
                                           "Native source regions are counted from XML; legacy canonical input has no document-artifact region map.",
                                           "Mutation and publication behavior require a separate test."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    print(json.dumps({key: result[key] for key in ["warm_mcp", "process_cold_cli", "peak_mcp_rss_bytes", "performance_gates"]}), flush=True)


if __name__ == "__main__":
    main()
