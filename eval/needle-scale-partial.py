"""Inventory compiled passages from a failed build without treating it as a published index."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--generation", type=Path, required=True)
parser.add_argument("--run", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    raise ValueError("preserve existing results; choose a new output")
counts, sources, field_bytes = Counter(), Counter(), Counter()
max_tokens = 0
hashes = set()
recipes = Counter()
file = args.generation / "chunks.jsonl"
with file.open(encoding="utf8") as lines:
    for line in lines:
        chunk = json.loads(line)
        counts["navigation" if chunk["navigation"] else "content"] += 1
        if not chunk["navigation"]:
            sources[chunk["source"]] += 1
            hashes.add(hashlib.sha256(chunk["body"].encode("utf8")).digest())
            counts["content_below_20_words"] += len(chunk["body"].split()) < 20
        recipes[chunk["recipe"]] += 1
        max_tokens = max(max_tokens, chunk["token_count"])
        for name in ["body", "text", "context", "breadcrumb", "citations", "terms_defined"]:
            value = chunk[name]
            values = value if isinstance(value, list) else [value]
            field_bytes[name] += sum(len(text.encode("utf8")) for text in values)
counts["distinct_content_bodies"] = len(hashes)
with file.open("rb") as stream:
    chunk_sha = hashlib.file_digest(stream, "sha256").hexdigest()
run = json.loads(args.run.read_text(encoding="utf-8-sig"))
report = {
    "schema_version": 1, "purpose": "failed-build diagnostic, not query or relevance qualification",
    "generation": args.generation.name,
    "published": (args.generation.parent.parent / "published" / (args.generation.name + ".ready")).exists(),
    "run": run, "passages": counts, "content_by_source": sources,
    "max_recorded_tokens": max_tokens, "recipes": recipes, "chunks_sha256": chunk_sha,
    "utf8_field_value_bytes": field_bytes,
    "artifact_bytes": {p.name: p.stat().st_size for p in args.generation.iterdir() if p.is_file()},
    "limits": ["Counts and token counts are recorded compiler output, not independent source/token verification.",
               "An unpublished partial generation cannot support query latency or freshness qualification."]
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
print(json.dumps(report), flush=True)
