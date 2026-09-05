"""Expand the frozen public seed through observed links/citations, in identifier order.

Every acquisition attempt is journaled. Existing seed bytes and lock are never replaced.
PMC full text uses OAI-PMH; ID resolution uses the approved ID converter.
"""
import argparse
import datetime as dt
import gzip
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.links = set()
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href: self.links.add(href)

def request(url):
    req = urllib.request.Request(url, headers={"User-Agent": "sect-corpus-evaluation/2.0", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = response.read()
        if response.headers.get("Content-Encoding") == "gzip": data = gzip.decompress(data)
        meta = {"resolved_url": response.url, "content_type": response.headers.get("Content-Type"), "last_modified": response.headers.get("Last-Modified")}
    time.sleep(1)
    return data, meta

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("raw/corpus-creation"))
    parser.add_argument("--lock", type=Path, default=Path("eval/corpora/creation.lock.json"))
    args = parser.parse_args()
    seeds = json.loads(Path("eval/corpora/sources.lock.json").read_text())["sources"]
    args.out.mkdir(parents=True, exist_ok=True)
    journal = args.out / "acquisition.jsonl"
    sources = {s["id"]: s for s in seeds}
    if args.lock.exists():
        sources.update({s["id"]: s for s in json.loads(args.lock.read_text())["sources"]})
    for s in sources.values():
        if hashlib.sha256(Path(s["file"]).read_bytes()).hexdigest() != s["sha256"]: raise ValueError("frozen source changed")
    failures = json.loads(args.lock.read_text()).get("failures", []) if args.lock.exists() else []
    def checkpoint():
        value = {"schema_version": 1, "selection": "observed seed links/citations, ascending source identifier; failed/non-OA acquisitions recorded", "sources": sorted(sources.values(), key=lambda s: s["id"]), "failures": failures}
        temp = args.lock.with_suffix(".tmp"); temp.write_text(json.dumps(value, indent=2)+"\n", encoding="utf-8"); temp.replace(args.lock)
    def acquire(s):
        if s["id"] in sources: return sources[s["id"]]
        try:
            data, meta = request(s["url"])
            if s["format"] == "pdf" and not data.startswith(b"%PDF-"): raise ValueError("non-PDF response")
            if s["format"] == "html" and b"<html" not in data.lower(): raise ValueError("non-HTML response")
            if s["format"] == "xml":
                root = ET.fromstring(data)
                if not any(e.tag.split("}")[-1] == "article" for e in root.iter()): raise ValueError("no licensed full-text article in OAI response")
                permissions = [ET.tostring(e, encoding="unicode") for e in root.iter() if e.tag.split("}")[-1] == "permissions"]
                if not permissions: raise ValueError("missing license metadata")
                meta["permissions"] = permissions
            file = args.out / f"{s['id']}.{s['format']}"
            file.write_bytes(data)
            result = {**s, **meta, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "file": file.as_posix(), "acquired_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            sources[s["id"]] = result
            event = {"id": s["id"], "status": "acquired", "sha256": result["sha256"]}
        except Exception as error:
            event = {"id": s["id"], "url": s["url"], "status": "failed", "reason": str(error)}; failures.append(event); result = None
        with journal.open("a", encoding="utf-8") as target: target.write(json.dumps(event)+"\n")
        print(json.dumps(event), flush=True); checkpoint(); return result

    fannie = next(s for s in seeds if s["id"].startswith("fannie"))
    links = Links(); links.feed(Path(fannie["file"]).read_text(encoding="utf-8"))
    urls = sorted({urllib.parse.urljoin(fannie["url"], u).split("#")[0] for u in links.links if re.search(r"/sel/b3-3\.\d+-\d+/", u)})
    for url in urls:
        if sum(s["id"] == "fannie-self-employed" or bool(re.search(r"/sel/b3-3\.\d+-\d+/", s["url"])) for s in sources.values()) >= 10: break
        if url == fannie["url"]: continue
        code = url.split("/sel/")[-1].split("/")[0]
        acquire({**{k:fannie[k] for k in ["domain","format","effective","license","license_url"]}, "id": "fannie-"+code, "url": url, "version": code+"; acquisition snapshot", "discovered_from": fannie["id"]})

    attention = next(s for s in seeds if s["id"] == "attention-v7")
    # Extract only identifier strings from the frozen paper; no hand-selected replacement list.
    try:
        import pypdf
        text = "\n".join(p.extract_text() or "" for p in pypdf.PdfReader(attention["file"]).pages)
    except ImportError:
        raise RuntimeError("run with the pinned adapter Python environment (pypdf dependency)")
    ids = sorted(set(re.findall(r"(?:arXiv[:\s]+|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5})(?:v\d+)?", text, re.I)))
    for arxiv_id in ids:
        if sum(s.get("discipline") == "ml" for s in sources.values()) >= 10: break
        if arxiv_id == "1706.03762": continue
        # v1 is a stable identifier, selected before acquisition; no floating latest endpoint.
        acquire({"id":"arxiv-"+arxiv_id.replace(".","-")+"v1", "domain":"research", "discipline":"ml", "format":"pdf", "url":f"https://arxiv.org/pdf/{arxiv_id}v1", "version":f"arXiv:{arxiv_id}v1", "effective":"2026-09-04", "license":"arXiv distribution license; no redistribution inferred", "license_url":f"https://arxiv.org/abs/{arxiv_id}v1", "discovered_from":"attention-v7"})

    frontier = [s for s in seeds if s.get("discipline") == "biomedical"]
    visited = set()
    while frontier and sum(s.get("discipline") == "biomedical" for s in sources.values()) < 10:
        source = frontier.pop(0)
        if source["id"] in visited: continue
        visited.add(source["id"])
        root = ET.parse(source["file"])
        pmids = sorted({(e.text or "").strip() for e in root.iter() if e.tag.split("}")[-1] == "pub-id" and e.attrib.get("pub-id-type") == "pmid"})
        for start in range(0,len(pmids),100):
            if sum(s.get("discipline") == "biomedical" for s in sources.values()) >= 10: break
            url = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?format=json&ids="+",".join(pmids[start:start+100])
            try: records = json.loads(request(url)[0])["records"]
            except Exception as error:
                failures.append({"id":source["id"],"url":url,"reason":str(error)}); continue
            for record in sorted(records,key=lambda r:r.get("pmcid","")):
                if sum(s.get("discipline") == "biomedical" for s in sources.values()) >= 10: break
                pmc = record.get("pmcid")
                if not pmc: continue
                number = pmc.removeprefix("PMC")
                result = acquire({"id":pmc.lower(),"domain":"research","discipline":"biomedical","format":"xml","url":f"https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:{number}&metadataPrefix=pmc","version":pmc+"; frozen OAI response","effective":"2026-09-04","license":"Exact license retained in JATS permissions; OA availability verified by full-text response","license_url":f"https://pmc.ncbi.nlm.nih.gov/articles/{pmc}/","discovered_from":source["id"]})
                if result: frontier.append(result)
    checkpoint()
    print(json.dumps({"fannie":sum(s["id"].startswith("fannie") for s in sources.values()),"ml":sum(s.get("discipline")=="ml" for s in sources.values()),"biomedical":sum(s.get("discipline")=="biomedical" for s in sources.values()),"failures":len(failures)}))

if __name__ == "__main__": main()
