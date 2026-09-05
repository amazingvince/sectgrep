"""Compare passage policies on identical organized inputs; fixed probes are diagnostic only."""
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import time
from qualification import Mcp

base=Path("corpora/needle-retrieval-v5")
binary=Path("target/release/sect.exe")
queries=[x["query"] for x in json.loads(Path("eval/results/chunk-search-examples-2026-09-05.json").read_text(encoding="utf8"))]
results=[]
for target,maximum in [(256,256),(512,800),(1024,1024)]:
    corpus=base if target==512 else Path(f"corpora/needle-policy-{target}")
    if corpus!=base:
        if not corpus.exists():
            shutil.copytree(base,corpus,ignore=shutil.ignore_patterns(".sect"))
        subprocess.run([str(binary),"--corpus",str(corpus),"index","--ngram","off","--passage-target",str(target),"--passage-max",str(maximum),"--json"],check=True,stdout=subprocess.DEVNULL)
    generation=sorted((corpus/".sect/published").glob("*.ready"))[-1].stem
    directory=corpus/".sect/generations"/generation
    chunks=[json.loads(line) for line in (directory/"chunks.jsonl").read_text(encoding="utf8").splitlines()]
    content=[c for c in chunks if not c["navigation"]]
    client=Mcp(binary,corpus,freshness=None)
    samples=[]; responses=[]
    try:
        for i,q in enumerate(queries):
            responses.append(client.search({"query":q,"source":"research" if i==3 else "lending","limit":5}))
        for _ in range(3):
            for i,q in enumerate(queries):
                start=time.perf_counter()
                client.search({"query":q,"source":"research" if i==3 else "lending","limit":5})
                samples.append((time.perf_counter()-start)*1000)
    finally:
        client.close()
    text="\n".join(h["evidence"]["primary"]["text"] for h in responses[0]["hits"])
    results.append({"target":target,"max":maximum,"generation":generation,"content_passages":len(content),"navigation_entries":len(chunks)-len(content),
        "median_body_words":statistics.median(len(c["body"].split()) for c in content),"max_measured_model_tokens":max(c["token_count"] for c in chunks),
        "source_unit_ids_sha256":hashlib.sha256("\n".join(sorted({s["expr"] for c in chunks for s in c["spans"]})).encode()).hexdigest(),
        "warm_median_ms":statistics.median(samples),"warm_max_ms":max(samples),"samples":len(samples),
        "fixed_query_total_clause_present":"downgrade and manually underwrite" in text,"fixed_query_manual_qualifiers_present":all(s in text for s in ["extenuating circumstance","minimum of 12 months","reduced income"]),
        "responses":responses})
assert len({r["source_unit_ids_sha256"] for r in results})==1,"rechunking changed source identities"
result={"purpose":"passage policy ablation","independently_judged":False,"notice":"Policies vary target and ceiling together. Fixed-source probes cannot select a universal winner; embedding and reranker comparisons remain separate.","results":results}
Path("eval/results/needle-policy-ablation-2026-09-05.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf8")
print(json.dumps([{k:v for k,v in r.items() if k!="responses"} for r in results],indent=2))
