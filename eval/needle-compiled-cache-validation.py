"""Measure a one-section edit against the frozen large corpus using two owned probe sections.

The real regulatory inputs stay unchanged. Run serially, after compilation and tests.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import time

from qualification import Mcp
import importlib.util

# Share the existing immutable-generation and MCP checks with the plain-text diagnostic.
_spec = importlib.util.spec_from_file_location("scale_mutation", Path(__file__).with_name("needle-scale-mutation.py"))
_helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helpers)
digest, generation, call = _helpers.digest, _helpers.generation, _helpers.call


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    corpus, binary = args.corpus.resolve(), args.binary.resolve()
    preparation = json.loads((corpus / ".work/scale-preparation.json").read_text(encoding="utf8"))
    if preparation["purpose"] != "real native-XML scale diagnostic; no relevance labels":
        raise ValueError("requires the dedicated scale diagnostic corpus")
    probe = corpus / "needle-cache-probe"
    if probe.exists() or args.output.exists():
        raise ValueError("probe or result already exists; preserve it")
    original = generation(corpus)
    pinned = {n: digest(original / n) for n in ["manifest.json", "chunks.jsonl", "vectors.bin"]}
    initial_manifest = json.loads((original / "manifest.json").read_text(encoding="utf8"))
    for source in preparation["sources"]:
        assert digest(corpus / f"cfr-title-{source['title']}/raw.xml") == source["raw_sha256"]
    report = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "purpose": "compiled passage-cache mutation diagnostic; no relevance labels",
              "binary_sha256": digest(binary), "original_generation": original.name,
              "cache_present_before_run": (original / "compiled-passages.json").is_file(),
              "baseline_files": initial_manifest["files"], "baseline_passages": initial_manifest["chunks"],
              "steps": [], "passed": False,
              "limits": ["Two synthetic probe sections are added to a real regulatory corpus; real source bytes are not edited.",
                         "Timings include freshness, rebuilding and reopening; no p95 claim from a single edit.",
                         "Structural graphs, snapshots and n-grams still rebuild; this measures passage-compiler reuse.",
                         "Initial seeding also creates the cache when the previous generation predates it."]}
    owned = {}
    session = Mcp(binary, corpus, freshness=None, timeout=900)

    def write(name, content):
        path = probe / name
        if path.exists() and (path not in owned or path.read_bytes() != owned[path]):
            raise ValueError("probe was changed by another writer")
        path.write_bytes(content)
        owned[path] = content

    def section(key, word):
        raw = f"NEEDLE_CACHE_PROBE_{word}: Preserve the complete calibration requirement.\n".encode()
        write(f"{key}.txt", raw)
        raw_hash = digest(probe / f"{key}.txt")
        markdown = f"""---
id: CACHE:{key}
source: needle-cache-probe
title: Cache probe {key}
level: {"title" if key == "a" else "section"}
parent: {"null" if key == "a" else "CACHE:a"}
order: 1
effective: 2024-01-01
supersedes: null
superseded_by: null
amended_by: []
overrides: []
narrows: []
defines: []
context: Isolated synthetic cache validation probe
provenance:
  raw: needle-cache-probe/{key}.txt
  raw_sha256: {raw_hash}
  locator: {{line: 1}}
  legal_status: derived
  ingest_run: compiled-cache-validation
  confidence: 1
  verified_by: []
---
# Cache probe {key}

{raw.decode()}""".encode()
        write(f"{key}.md", markdown)

    def remove_probe():
        for path, content in owned.items():
            if path.exists() and path.read_bytes() != content:
                raise ValueError(f"probe changed externally; retained {path}")
        for path in owned:
            if path.exists():
                path.unlink()
        if probe.exists():
            probe.rmdir()  # No recursive deletion; unexpected files are retained.

    try:
        baseline_query = {"query": "electronic records audit trail", "source": "cfr-title-21", "limit": 5}
        baseline = call(session, "sect_search", baseline_query)
        assert generation(corpus) == original, "baseline must already be fresh"
        previous = original

        def observe(action, word, expected_compiled=None):
            nonlocal previous
            start = time.perf_counter()
            result = call(session, "sect_grep", {"pattern": "NEEDLE_CACHE_PROBE_(ALPHA|BRAVO)",
                                                "glob": ["needle-cache-probe/*.md"]})
            elapsed = (time.perf_counter() - start) * 1000
            current = generation(corpus)
            assert current != previous, "mutation must publish a new generation"
            manifest = json.loads((current / "manifest.json").read_text(encoding="utf8"))
            cache = manifest["passage_cache"]
            assert result["total_matches"] == (1 if word else 0)
            if word:
                assert len(result["lines"]) == 1 and f"NEEDLE_CACHE_PROBE_{word}" in result["lines"][0]["text"]
            if expected_compiled is not None:
                assert cache["compiled_documents"] == expected_compiled, cache
                assert cache["reused_documents"] == manifest["files"] - expected_compiled, cache
            step = {"action": action, "elapsed_ms_including_refresh": elapsed,
                    "generation": current.name, "passage_cache": cache, "layer_ms": manifest["layer_ms"]}
            report["steps"].append(step)
            print(json.dumps(step), flush=True)
            previous = current

        probe.mkdir()
        write("_source.yaml", b"name: needle-cache-probe\nkind: base\nid_prefix: 'CACHE:'\nprecedence: 0\nlegal_status: derived\n")
        section("a", "ALPHA")
        section("b", "STABLE")
        observe("seed two probe sections and cache", "ALPHA")
        original_size = (probe / "a.md").stat().st_size
        section("a", "BRAVO")
        assert (probe / "a.md").stat().st_size == original_size
        observe("edit one section", "BRAVO", 1)
        edited = call(session, "sect_search", {"query": "NEEDLE_CACHE_PROBE_BRAVO", "source": "needle-cache-probe", "limit": 5})
        assert any(h["id"] == "CACHE:a" and "BRAVO" in h["snippet"] for h in edited["hits"]), edited
        remove_probe()
        observe("remove probe sections", None, 0)
        assert call(session, "sect_search", baseline_query) == baseline
        for name in ["chunks.jsonl", "vectors.bin"]:
            assert digest(generation(corpus) / name) == pinned[name], name
        for name, expected in pinned.items():
            assert digest(original / name) == expected, f"old generation mutated: {name}"
        for source in preparation["sources"]:
            assert digest(corpus / f"cfr-title-{source['title']}/raw.xml") == source["raw_sha256"]
        report.update(passed=True, final_generation=generation(corpus).name,
                      final_cache_manifest_bytes=(generation(corpus) / "compiled-passages.json").stat().st_size,
                      canonical_passages_vectors_and_answers_unchanged=True, old_generation_immutable=True,
                      real_raw_sources_unchanged=True, peak_mcp_rss_including_rebuilds=session.peak_rss())
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        session.close()
        if probe.exists():
            try:
                remove_probe()
                report["probe_removed_after_failure"] = True
                report["post_failure_index_may_be_stale"] = True
            except Exception as error:
                report["cleanup_error"] = repr(error)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"passed": report["passed"], "peak_mcp_rss_including_rebuilds": report["peak_mcp_rss_including_rebuilds"]}), flush=True)


if __name__ == "__main__":
    main()
