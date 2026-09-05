"""Matched diagnostic storage comparison using one binary and identical canonical text."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("needle_validation", Path(__file__).with_name("needle-validation.py"))
validation = module_from_spec(spec)
spec.loader.exec_module(validation)


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inspect(corpus):
    directory = validation.generation(corpus)
    manifest = load(directory / "manifest.json")
    inputs = load(directory / "fingerprints.json")
    all_files = [p for p in directory.rglob("*") if p.is_file()]
    return {"generation": directory.name, "logical_sections": manifest["files"], "chunks": manifest["chunks"],
            "tracked_inputs": len(inputs["files"]), "tracked_directories": len(inputs["dirs"]),
            "generation_files": len(all_files), "generation_logical_bytes": sum(p.stat().st_size for p in all_files),
            "snapshot_markdown_files": len(list((directory / "corpus").rglob("*.md"))),
            "canonical_store_bytes": (directory / "sections.bin").stat().st_size if (directory / "sections.bin").exists() else None,
            "passages_sha256": sha(directory / "chunks.jsonl"), "regions_sha256": sha(directory / "regions.json"),
            "manifest": {k: manifest[k] for k in ("embedding_spec", "passage_recipe", "passage_policy")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, default=Path("corpora/needle-retrieval-v5"))
    parser.add_argument("--after", type=Path, default=Path("corpora/needle-document-store-v1"))
    parser.add_argument("--binary", type=Path, default=Path("target/release/sect.exe"))
    parser.add_argument("--output", type=Path, default=Path("eval/results/needle-document-store-2026-09-05.json"))
    args = parser.parse_args()
    before, after = inspect(args.before), inspect(args.after)
    assert before["passages_sha256"] == after["passages_sha256"], "passages changed during migration"
    assert before["regions_sha256"] == after["regions_sha256"], "native evidence changed during migration"
    assert before["manifest"] == after["manifest"]
    old, new = validation.generation(args.before), validation.generation(args.after)
    catalog = load(new / "sections.json")
    data = (new / "sections.bin").read_bytes()
    for relative, span in catalog.items():
        assert data[span["start"]:span["end"]] == (old / "corpus" / relative).read_bytes(), relative
    cases = [{"query": item["query"], "source": "research" if i == 3 else "lending"}
             for i, item in enumerate(load("eval/results/chunk-search-examples-2026-09-05.json"))]
    checks = []
    for case in cases:
        previous = validation.run(args.binary, args.before, **case)["result"]
        current = validation.run(args.binary, args.after, **case)["result"]
        # Output evidence and all returned identities must agree, not just the leading title.
        for key in ("hits", "supporting_context", "evidence_word_budget"):
            assert previous[key] == current[key], f"{case['query']}: changed {key}"
        checks.append({**case, "search_evidence_identical": True})
    for pattern, source in [("greater than 20 percent", "lending"), ("minimum of 12 months", "lending"), ("Attention", "research"), ("sample-79|nova-079", "fixtures")]:
        outputs = []
        for corpus in (args.before, args.after):
            command = [str(args.binary), "--corpus", str(corpus), "grep", pattern, "-g", "*.md", "--source", source, "--annotate", "--json", "--no-refresh"]
            result = json.loads(subprocess.run(command, capture_output=True, encoding="utf8", check=True).stdout)["result"]
            outputs.append({key: result[key] for key in ("lines", "per_file", "total_matches")})
        assert outputs[0] == outputs[1], pattern
        checks.append({"pattern": pattern, "source": source, "exact_evidence_identical": True})
    # Run serially, with no builds or other benchmark jobs competing for resources.
    timing = {"before": validation.timing(args.binary, args.before, cases), "after": validation.timing(args.binary, args.after, cases)}
    report = {"schema_version": 1, "purpose": "matched diagnostic storage comparison", "binary_sha256": sha(args.binary),
              "before": before, "after": after, "canonical_projections_checked": len(catalog), "checks": checks, "latency": timing,
              "limits": ["Nine documents; six real and three generated fixtures. No 100k real corpus qualification.",
                         "Same binary, model and canonical text; this measures storage/freshness, not relevance improvement.",
                         "Process-cold timing has an uncontrolled OS cache. Logical bytes count hard links repeatedly across generations.",
                         "Canonical projection text is packed; source evidence and derived chunks/parse caches still repeat text."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
