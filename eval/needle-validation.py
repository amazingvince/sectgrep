"""Source-based diagnostic comparisons, quote integrity, and default-path latency.

These fixed failure cases and generated fixtures are not independent relevance labels.
Run after needle-pilot.mjs, needle-baseline.py, and indexing each isolated corpus.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import statistics
import subprocess
import time
from qualification import Mcp

def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))

def generation(corpus):
    name = sorted((corpus/".sect/published").glob("*.ready"))[-1].stem
    return corpus/".sect/generations"/name

def run(binary, corpus, query, source=None):
    args = [str(binary), "--corpus", str(corpus), "search", query, "--limit", "5", "--json", "--no-refresh"]
    if source:
        args += ["--source", source]
    return json.loads(subprocess.run(args, capture_output=True, encoding="utf8", check=True, timeout=30).stdout)

def timing(binary, corpus, cases):
    # Default freshness scan: no optional native notification shortcut.
    client = Mcp(binary, corpus, freshness=None)
    warm = []
    try:
        for case in cases:
            client.search({"query":case["query"], "source":case["source"], "limit":5})
        for _ in range(5):
            for case in cases:
                start = time.perf_counter()
                client.search({"query":case["query"], "source":case["source"], "limit":5})
                warm.append((time.perf_counter()-start)*1000)
        rss = client.peak_rss()
    finally:
        client.close()
    cold = []
    for _ in range(3):
        for case in cases:
            args = [str(binary),"--corpus",str(corpus),"search",case["query"],"--source",case["source"],"--limit","5","--json"]
            start=time.perf_counter()
            subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True,timeout=30)
            cold.append((time.perf_counter()-start)*1000)
    def distribution(values):
        ordered=sorted(values)
        return {"samples":len(values),"p50_ms":statistics.median(values),"p95_ms":ordered[__import__('math').ceil(len(values)*.95)-1],"max_ms":max(values)}
    return {"freshness":"default", "warm_mcp":distribution(warm), "process_cold_cli":distribution(cold), "peak_mcp_rss_bytes":rss,
            "notice":"Small diagnostic corpus, process-cold with OS cache uncontrolled; not 100k qualification."}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus",type=Path)
    parser.add_argument("--binary",type=Path,default=Path("target/release/sect.exe"))
    parser.add_argument("--baseline",type=Path,default=Path("corpora/needle-retrieval-baseline"))
    parser.add_argument("--baseline-binary",type=Path,default=Path("review/rust-performance/baseline-sect.exe"))
    parser.add_argument("--output",type=Path,default=Path("eval/results/needle-retrieval-validation-2026-09-05.json"))
    args=parser.parse_args()
    cases=[{"query":item["query"],"source":"research" if i==3 else "lending"} for i,item in enumerate(load("eval/results/chunk-search-examples-2026-09-05.json"))]
    current_dir=generation(args.corpus)
    baseline_dir=generation(args.baseline)
    documents=list(load(current_dir/"regions.json")["documents"].values())
    originals=list(load(baseline_dir/"regions.json")["documents"].values())
    assert {d["raw_sha256"] for d in originals} == {d["raw_sha256"] for d in documents if d["document"].split(":")[1] in {"lending","research"}}
    bodies={}
    for line in (current_dir/"docs.jsonl").read_text(encoding="utf8").splitlines():
        doc=json.loads(line)["doc"]
        body=re.sub(r"\[([^\]]*)\]\(([^)\s]*)\)",r"\1",doc["body"])
        bodies[f'{doc["front"]["id"]}@{doc["front"]["effective"]}']=body.encode("utf8")
    provenance={f'{u["id"]}@{d["effective"]}':(d,u) for d in documents for u in d["units"]}
    checks=[]
    def verify(response):
        result=response["result"]
        count=0
        for hit in result["hits"]:
            assert hit["role"]!="navigation", "body query returned navigation"
            packet=hit["evidence"]
            count+=packet["words"]
            for excerpt in [packet["primary"],*packet["context"]]:
                for span in excerpt["spans"]:
                    body=bodies[span["expr"]]
                    assert hashlib.sha256(body).hexdigest()==span["body_sha256"]
                    assert body[span["byte_start"]:span["byte_end"]].decode("utf8")==excerpt["text"]
        count+=sum(len(c["body"].split()) for c in result["supporting_context"])
        assert count<=result["evidence_word_budget"]
    def quote_on_page(result,page,needles):
        for hit in result["hits"]:
            d,u=provenance[hit["expr"]]
            region_ids=set(u["regions"])
            pages={r["locator"].get("page") for r in d["regions"] if r["id"] in region_ids}
            text=hit["evidence"]["primary"]["text"].lower()
            if page in pages and all(needle.lower() in text for needle in needles):
                return {"rank":hit["rank"],"expr":hit["expr"],"raw_sha256":d["raw_sha256"],"page":page,"quote":hit["evidence"]["primary"]["text"]}
        return None
    responses=[]
    for case in cases:
        before=run(args.baseline_binary,args.baseline,**case)
        after=run(args.binary,args.corpus,**case)
        verify(after)
        responses.append({**case,"before":before,"after":after})
    first=responses[0]["after"]["result"]
    total=quote_on_page(first,255,["greater than 20 percent","downgrade and manually underwrite"])
    manual=quote_on_page(first,334,["extenuating circumstance","minimum of 12 months","reduced income"])
    checks.extend([{"case":"FHA TOTAL operative clause","passed":bool(total),"evidence":total},{"case":"FHA Manual qualifications","passed":bool(manual),"evidence":manual}])
    for query,required in [("sample-79 calibration pressure",["sample-79","calibration"]),("quasar temperature retention provisional calibration",["seven years"]),("nova-079 provisional temperature",["nova-079","301","provisional"])]:
        response=run(args.binary,args.corpus,query,"fixtures");verify(response)
        found=any(all(term.lower() in h["evidence"]["primary"]["text"].lower() for term in required) for h in response["result"]["hits"])
        checks.append({"case":query,"passed":found,"response":response})
    # Mechanical assertions remain useful even when no independent relevance judgments exist.
    result={"schema_version":1,"purpose":"diagnostic","independently_judged":False,"generation":current_dir.name,"baseline_generation":baseline_dir.name,
            "matched_raw_revisions":len(originals),"source_filters":"identical lending/research raw inputs; three synthetic fixtures excluded from matched queries",
            "current_binary_sha256":hashlib.sha256(args.binary.read_bytes()).hexdigest(),"baseline_binary_sha256":hashlib.sha256(args.baseline_binary.read_bytes()).hexdigest(),
            "checks":checks,"source_quote_and_budget_checks_passed":True,"responses":responses,
            "latency":{"before":timing(args.baseline_binary,args.baseline,cases),"after":timing(args.binary,args.corpus,cases)},
            "qualification":"Independent held-out recall, semantic completeness, parser truth and real 100k scale remain unqualified."}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
    print(json.dumps({"checks":[{"case":c["case"],"passed":c["passed"]} for c in checks],"latency":result["latency"]},indent=2))
    if not all(c["passed"] for c in checks):
        raise SystemExit(1)

if __name__=="__main__":
    main()
