"""Freeze or reproduce the small public-source acquisition manifest, sequentially.

Uses PMC's approved OAI-PMH interface, not article page scraping. Raw files remain
in ignored raw/. No credentials, hosted models, or publication actions are involved.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import time
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--manifest", type=Path, default=Path("eval/corpora/sources.json"))
    p.add_argument("--lock", type=Path, default=Path("eval/corpora/sources.lock.json"))
    p.add_argument("--out", type=Path, default=Path("raw/qualification"))
    p.add_argument("--freeze", action="store_true", help="Create a new immutable lock; refuses to replace an existing lock")
    a = p.parse_args()
    if a.freeze and a.lock.exists():
        p.error("lock already exists; choose a new lock path for a new acquisition snapshot")
    catalog = json.loads(a.manifest.read_text())
    locked = {} if a.freeze else {s["id"]: s for s in json.loads(a.lock.read_text())["sources"]}
    a.out.mkdir(parents=True, exist_ok=True)
    sources = []
    for s in catalog["sources"]:
        target = a.out / f"{s['id']}.{s['format']}"
        if not a.freeze and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == locked[s["id"]]["sha256"]:
            sources.append(locked[s["id"]])
            continue
        request = urllib.request.Request(s["url"], headers={"User-Agent": "sect-corpus-evaluation/1.0 (four-document smoke acquisition)", "Accept-Encoding": "gzip, deflate"})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read()
            encoding = response.headers.get("Content-Encoding")
            if encoding == "gzip":
                data = gzip.decompress(data)
            elif encoding == "deflate":
                data = zlib.decompress(data)
            metadata = dict(resolved_url=response.url, content_type=response.headers.get("Content-Type"), etag=response.headers.get("ETag"), last_modified=response.headers.get("Last-Modified"))
        if s["format"] == "pdf" and not data.startswith(b"%PDF-"):
            raise ValueError(f"{s['id']}: expected PDF, received another payload")
        if s["format"] == "xml":
            dom = ET.fromstring(data)
            if not any(e.tag.split("}")[-1] == "article" for e in dom.iter()):
                raise ValueError("PMC response did not include licensed full-text JATS")
            metadata["oai_datestamps"] = [e.text for e in dom.iter() if e.tag.split("}")[-1] == "datestamp"]
            metadata["permissions"] = [ET.tostring(e, encoding="unicode") for e in dom.iter() if e.tag.split("}")[-1] == "permissions"]
        sha = hashlib.sha256(data).hexdigest()
        if not a.freeze and sha != locked[s["id"]]["sha256"]:
            raise ValueError(f"{s['id']}: source changed from frozen hash; do not overwrite the benchmark")
        target.write_bytes(data)
        sources.append({**s, **metadata, "sha256": sha, "bytes": len(data), "acquired_at": dt.datetime.now(dt.timezone.utc).isoformat(), "file": str(target).replace("\\", "/")})
        print(f"{s['id']}: {len(data)} bytes, {sha}", flush=True)
        time.sleep(1)  # Sequential, below PMC's three-requests/second limit.
    if a.freeze:
        a.lock.parent.mkdir(parents=True, exist_ok=True)
        with a.lock.open("x", encoding="utf-8") as f:
            json.dump({"schema_version": 1, "catalog_sha256": hashlib.sha256(a.manifest.read_bytes()).hexdigest(), "sources": sources}, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
