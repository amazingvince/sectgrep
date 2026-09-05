"""Report a pinned parser comparison without converting heuristics to accuracy scores."""
import hashlib
import json
from pathlib import Path
from collections import Counter

def load(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))

native=load("corpora/needle-retrieval-v5/research/attention-v7.document.json")
converted=load("corpora/needle-docling-attention/research/attention-v7.document.json")
artifact=load("review/needle-retrieval/docling-attention.json")
partial=load("review/needle-retrieval/docling-fha255.json")
fha=load("corpora/needle-retrieval-v5/lending/fha-handbook-u18.document.json")
assert native["raw_sha256"]==converted["raw_sha256"]==artifact["sect_adapter"]["raw_sha256"]
assert fha["raw_sha256"]==partial["sect_adapter"]["raw_sha256"]
def summary(d):
    return {"regions":len(d["regions"]),"units":len(d["units"]),"kinds":dict(Counter(r["kind"] for r in d["regions"])),"parser":d["parser"],"exclusions":sum(bool(r["exclusion"]) for r in d["regions"])}
def paragraphs(d):
    return [{"text":r["text"],"locator":r["locator"],"uncertainty":r["uncertainty"]} for r in d["regions"] if "divide" in r["text"] and "keys" in r["text"]]
def page_text_native(d,page):
    return "\n".join(r["text"] for r in d["regions"] if r["locator"].get("page")==page and not r["exclusion"])
def page_text_docling(d,page):
    return "\n".join(x.get("text") or x.get("orig") or "" for x in d["document"]["texts"] if any(p["page_no"]==page for p in x.get("prov",[])))
fha_checks=[]
for literal in ["greater than 20 percent", "downgrade and manually underwrite", "at least two years"]:
    fha_checks.append({"literal":literal,"native_page255":literal in page_text_native(fha,255),"docling_page255":literal in page_text_docling(partial,255)})
result={"purpose":"diagnostic parser comparison","independently_judged":False,
        "attention":{"raw_sha256":native["raw_sha256"],"native":summary(native),"docling":summary(converted),"native_attention_paragraph":paragraphs(native),"docling_attention_paragraph":paragraphs(converted),
            "equations_preserved_from_original_field":sum("parser_original_text_fallback" in r["uncertainty"] and r["kind"]=="equation" for r in converted["regions"]),
            "docling_query":load("review/needle-retrieval/docling-query.json")},
        "fha":{"raw_sha256":fha["raw_sha256"],"docling_page_range":"254:256","coverage":"partial comparison; not publishable as a complete document","literal_checks":fha_checks},
        "grobid":{"status":"not run","reason":"Local service at 127.0.0.1:8070 refused connection; Docker is not enabled in this WSL distribution.","adapter":"eval/adapters/grobid_adapter.py","api_documentation":"https://grobid.readthedocs.io/en/latest/Grobid-service/"},
        "decision":"Keep explicit parser selection. Docling improves reading order in this attention paragraph and retains tables, but promotes diagram labels to sections and currently ranks a caption ahead of the explanatory provision. Its original formula string still loses two-dimensional notation. Neither parser is qualified as a universal default.",
        "artifacts":{file:hashlib.sha256(Path(file).read_bytes()).hexdigest() for file in ["review/needle-retrieval/docling-attention.json","review/needle-retrieval/docling-fha255.json"]}}
Path("eval/results/needle-parser-comparison-2026-09-05.json").write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
print(json.dumps({"attention_native":summary(native),"attention_docling":summary(converted),"fha_literals":fha_checks,"decision":result["decision"]},indent=2))
