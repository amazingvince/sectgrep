"""Export a fixed, source-bound diagnostic corpus and actual Rust candidates for model comparisons."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=Path("corpora/needle-document-store-v1"))
    parser.add_argument("--binary", type=Path, default=Path("target/release/sect.exe"))
    parser.add_argument("--output", type=Path, default=Path("review/needle-retrieval/model-experiments/inputs.json"))
    args = parser.parse_args()
    generation = sorted((args.corpus / ".sect/published").glob("*.ready"))[-1].stem
    directory = args.corpus / ".sect/generations" / generation
    chunks = [json.loads(line) for line in (directory / "chunks.jsonl").read_text(encoding="utf8").splitlines()]
    chunks = [c for c in chunks if not c["navigation"]]
    cases = [{"query": item["query"], "source": "research" if i == 3 else "lending"} for i, item in enumerate(load("eval/results/chunk-search-examples-2026-09-05.json"))]
    cases += [{"query": q, "source": "fixtures"} for q in ["sample-79 calibration pressure", "quasar temperature retention provisional calibration", "nova-079 provisional temperature"]]
    reference = load("eval/results/needle-retrieval-validation-2026-09-05.json")
    cases[0]["targets"] = [{"expr": c["evidence"]["expr"], "label": c["case"]} for c in reference["checks"][:2]]
    for case in cases:
        case["rust"] = {}
        for mode, flag in [("hybrid", None), ("vector", "--vector"), ("lexical", "--fts")]:
            command = [str(args.binary), "--corpus", str(args.corpus), "search", case["query"], "--source", case["source"], "--limit", "50", "--json", "--no-refresh"]
            if flag:
                command.append(flag)
            result = json.loads(subprocess.run(command, capture_output=True, encoding="utf8", check=True, timeout=30).stdout)["result"]
            case["rust"][mode] = [{key: h[key] for key in ["chunk_id", "expr", "rank", "score", "cosine"]} for h in result["hits"]]
        print(case["query"], len(case["rust"]["hybrid"]), flush=True)
    output = {"purpose": "diagnostic only; not independent relevance labels", "generation": generation,
              "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "chunks_sha256": hashlib.sha256((directory / "chunks.jsonl").read_bytes()).hexdigest(),
              "manifest": load(directory / "manifest.json"), "chunks": chunks, "cases": cases}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False), encoding="utf8")


if __name__ == "__main__":
    main()
