"""Exercise default freshness on an isolated real corpus using an owned plain-text probe.

Run after the unchanged-input benchmark. No canonical regulatory text is modified.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import time
from qualification import Mcp


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def generation(corpus):
    return corpus / ".sect/generations" / sorted((corpus / ".sect/published").glob("*.ready"))[-1].stem


def call(session, name, arguments):
    response = session.request("tools/call", {"name": name, "arguments": arguments})
    if response.get("isError"):
        raise RuntimeError(response)
    envelope = response["structuredContent"]
    if envelope["freshness"]["state"] != "fresh":
        raise ValueError("default refresh returned stale evidence")
    return envelope["result"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--restore-mtime", action="store_true",
                        help="stress the known metadata-scan limitation; expect failure until content-change detection is strengthened")
    args = parser.parse_args()
    corpus, binary = args.corpus.resolve(), args.binary.resolve()
    preparation = json.loads((corpus / ".work/scale-preparation.json").read_text(encoding="utf8"))
    if preparation["purpose"] != "real native-XML scale diagnostic; no relevance labels":
        raise ValueError("requires the dedicated scale diagnostic corpus")
    marker = corpus / "scale-freshness-probe.txt"
    if marker.exists() or args.output.exists():
        raise ValueError("probe or output already exists; preserve it")
    if os.environ.get("SECT_FRESHNESS_WATCH") == "1":
        raise ValueError("default scan required; disable experimental watcher")
    original = generation(corpus)
    pinned_hashes = {name: digest(original / name) for name in ["manifest.json", "chunks.jsonl", "vectors.bin"]}
    for source in preparation["sources"]:
        if digest(corpus / f"cfr-title-{source['title']}/raw.xml") != source["raw_sha256"]:
            raise ValueError("source binding changed before test")
    alpha = b"Plain-text freshness fixture: NEEDLE_SCALE_FRESHNESS_ALPHA_20260905\n"
    bravo = alpha.replace(b"ALPHA", b"BRAVO")
    report = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "purpose": "large-corpus default-refresh mutation diagnostic; no relevance judgments",
              "corpus": str(corpus), "binary_sha256": digest(binary), "original_generation": original.name,
              "restored_mtime_stress": args.restore_mtime,
              "steps": [], "passed": False,
              "limits": ["The owned text probe exercises exact-search freshness; canonical passages remain unchanged.",
                         "Mutation timings and peak MCP RSS include automatic index rebuilds, not only retrieval.",
                         "Old artifact hashes check immutability; concurrent in-memory reader pins are covered by Rust regressions."]}
    session = Mcp(binary, corpus, freshness=None, timeout=900)
    owned = False
    try:
        query = {"query": "electronic records audit trail", "source": "cfr-title-21", "limit": 5}
        baseline = call(session, "sect_search", query)
        if generation(corpus) != original:
            raise ValueError("baseline was stale; run the unchanged-input benchmark first")
        previous = original
        def check_probe(action, expected):
            nonlocal previous
            start = time.perf_counter()
            result = call(session, "sect_grep", {"pattern": "NEEDLE_SCALE_FRESHNESS_(ALPHA|BRAVO)_20260905", "glob": [marker.name]})
            elapsed = (time.perf_counter() - start) * 1000
            current = generation(corpus)
            if current == previous:
                raise ValueError(f"{action}: mutation did not publish a new generation")
            lines = [row["text"] for row in result["lines"]]
            if result["total_matches"] != (1 if expected else 0):
                raise ValueError(f"{action}: wrong exact match count")
            if expected and (len(lines) != 1 or lines[0].rstrip("\r\n") != expected.decode().rstrip("\r\n")):
                raise ValueError(f"{action}: stale or changed quote")
            step = {"action": action, "elapsed_ms_including_refresh": elapsed, "generation": current.name,
                    "fresh": True, "total_matches": result["total_matches"]}
            report["steps"].append(step)
            previous = current
            print(json.dumps(step), flush=True)

        with marker.open("xb") as target:
            target.write(alpha)
        owned = True
        check_probe("create", alpha)
        stamp = marker.stat()
        marker.write_bytes(bravo)
        assert marker.stat().st_size == stamp.st_size
        if args.restore_mtime:
            os.utime(marker, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            assert marker.stat().st_mtime_ns == stamp.st_mtime_ns
        check_probe("same-size edit with restored mtime" if args.restore_mtime else "same-size edit", bravo)
        marker.unlink()
        owned = False
        check_probe("delete", None)
        if call(session, "sect_search", query) != baseline:
            raise ValueError("canonical search results changed under plain-text probe mutations")
        for name in ["chunks.jsonl", "vectors.bin"]:
            if digest(generation(corpus) / name) != pinned_hashes[name]:
                raise ValueError(f"unchanged canonical artifact changed: {name}")
        for name, expected in pinned_hashes.items():
            if digest(original / name) != expected:
                raise ValueError(f"old generation mutated: {name}")
        for source in preparation["sources"]:
            if digest(corpus / f"cfr-title-{source['title']}/raw.xml") != source["raw_sha256"]:
                raise ValueError("raw source changed")
        report.update(passed=True, final_generation=generation(corpus).name,
                      canonical_search_unchanged=True, raw_sources_unchanged=True,
                      old_artifacts_immutable=True, canonical_passages_and_vectors_unchanged=True,
                      peak_mcp_rss_including_rebuilds=session.peak_rss())
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        session.close()
        if owned and marker.exists() and marker.read_bytes() in (alpha, bravo):
            marker.unlink()
            report["probe_removed_after_failure"] = True
            report["post_failure_index_may_be_stale"] = True
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"passed": report["passed"], "final_generation": report["final_generation"]}), flush=True)


if __name__ == "__main__":
    main()
