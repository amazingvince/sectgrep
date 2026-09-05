"""Read-only diagnosis of current source units and retrieval chunks. Counts are words."""
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import statistics
import sys

root = Path(__file__).resolve().parents[1]
corpus = root / "corpora/corpus-creation-pilot-v2"
generation = sys.argv[1]
index = corpus / ".sect/generations" / generation
chunks = [json.loads(line) for line in (index / "chunks.jsonl").read_text(encoding="utf-8").splitlines()]
doc_paths = [p for s in ["research", "lending"] for p in sorted((index / "corpus" / s).glob("*.document.json")) if "@" not in p.name]
docs = [json.loads(p.read_text(encoding="utf-8")) for p in doc_paths]
words = lambda s: len(s.split())
def dist(values):
    values = sorted(values)
    if not values:
        return {"n": 0}
    return {"n": len(values), "min": values[0], "p10": values[int((len(values)-1)*.1)], "median": statistics.median(values), "p90": values[int((len(values)-1)*.9)], "max": values[-1], "under_20": sum(v < 20 for v in values), "under_50": sum(v < 50 for v in values), "over_2000": sum(v > 2000 for v in values)}
by_doc = defaultdict(list)
for c in chunks:
    by_doc[c["id"].split("/")[0]].append(c)
rows = []
for d in docs:
    regions = {r["id"]: r for r in d["regions"]}
    content = ["\n".join(regions[r]["text"] for r in u["regions"] if regions[r]["kind"] != "heading") for u in d["units"]]
    selected = by_doc[d["document"]]
    rows.append({"document": d["document"], "format": d["format"], "raw": d["raw"], "regions": len(regions), "kinds": dict(Counter(r["kind"] for r in regions.values())), "units": len(d["units"]), "heading_only_units": sum(not s.strip() for s in content), "heading_without_level": sum(r["kind"] == "heading" and not r["heading_level"] for r in regions.values()), "body_words": dist([words(s) for s in content]), "chunk_body_words": dist([words(c["body"]) for c in selected]), "examples": [{"id": u["id"], "title": u["title"], "body": s[:350], "regions": len(u["regions"])} for u, s in zip(d["units"],content) if words(s) < 20][:8]})
    rows[-1]["units_without_parent"] = sum(u["parent"] is None for u in d["units"])
    rows[-1]["repeated_titles"] = Counter(u["title"] for u in d["units"]).most_common(8)
formats = {}
for fmt in sorted({d["format"] for d in docs}):
    ds = [d for d in docs if d["format"] == fmt]
    ids = {d["document"] for d in ds}
    cs = [c for c in chunks if c["id"].split("/")[0] in ids]
    formats[fmt] = {"documents": len(ds), "units": sum(len(d["units"]) for d in ds), "chunks": len(cs), "body_words": dist([words(c["body"]) for c in cs]), "heading_only_units": sum(r["heading_only_units"] for r in rows if r["format"]==fmt), "heading_without_level": sum(r["heading_without_level"] for r in rows if r["format"]==fmt)}
result = {"corpus": str(corpus.relative_to(root)), "generation": generation, "word_count_method": "whitespace split; not model-token counts", "documents": len(docs), "units": sum(len(d["units"]) for d in docs), "chunks": len(chunks), "chunk_sha256": hashlib.sha256((index/"chunks.jsonl").read_bytes()).hexdigest(), "chunk_body_words": dist([words(c["body"]) for c in chunks]), "chunk_embedded_words": dist([words(c["text"]) for c in chunks]), "formats": formats, "documents_detail": rows}
result["document_artifacts"] = {str(p.relative_to(index)): hashlib.sha256(p.read_bytes()).hexdigest() for p in doc_paths}
result["root_chunks"] = [{"id": c["id"], "body_words": words(c["body"])} for c in chunks if "/" not in c["id"]]
out = root / "eval/results/chunk-audit-2026-09-05.json"
out.write_text(json.dumps(result, indent=2, ensure_ascii=False)+"\n", encoding="utf-8")
print(json.dumps({k:v for k,v in result.items() if k!="documents_detail"},indent=2))
print(json.dumps([{k:r[k] for k in ["document", "units", "heading_only_units", "body_words"]} for r in rows],indent=2))
