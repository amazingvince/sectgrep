"""Freeze real eCFR titles for scale diagnostics; never duplicate content or replace a lock.

Selection is fixed before timing: Titles 21, 26 and 40, complete native XML.
This is a regulatory workload, not a relevance benchmark or a multi-format qualification.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def inspect(path, title):
    counts = {"sections": 0, "divisions": 0, "paragraphs": 0, "tables": 0}
    volumes = []
    for _, element in ET.iterparse(path, events=["end"]):
        if element.tag.startswith("DIV"):
            counts["divisions"] += 1
            counts["sections"] += element.get("TYPE") == "SECTION"
        if element.tag == "DIV1" and element.get("TYPE") == "TITLE":
            volumes.append(dict(element.attrib))
        counts["paragraphs"] += element.tag == "P"
        counts["tables"] += element.tag in {"GPOTABLE", "TABLE"}
        element.clear()
    if not volumes or any(not v.get("NODE", "").startswith(f"{title}:") for v in volumes) or counts["sections"] < 100:
        raise ValueError(f"unexpected/incomplete title XML: {title}: {volumes}, {counts}")
    return {"title_volumes": volumes, "xml_counts": counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("raw/needle-scale"))
    parser.add_argument("--lock", type=Path, default=Path("eval/corpora/needle-scale.lock.json"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.lock.exists():
        locked = json.loads(args.lock.read_text(encoding="utf8"))
        for source in locked["sources"]:
            if digest(source["file"]) != source["sha256"]:
                raise ValueError(f"frozen raw bytes changed: {source['file']}")
        print("All frozen source hashes verified.", flush=True)
        return
    sources = []
    for title in [21, 26, 40]:
        file = args.out / f"ECFR-title{title}.xml"
        receipt = file.with_suffix(".receipt.json")
        if file.exists() or receipt.exists():
            if not file.exists() or not receipt.exists():
                raise ValueError(f"incomplete prior acquisition: {file}; use a new output directory")
            source = json.loads(receipt.read_text(encoding="utf8"))
            if digest(file) != source["sha256"]:
                raise ValueError(f"previous acquisition changed: {file}")
        else:
            url = f"https://www.govinfo.gov/bulkdata/ECFR/title-{title}/ECFR-title{title}.xml"
            request = urllib.request.Request(url, headers={"User-Agent": "sect-scale-evaluation/1.0"})
            part = file.with_suffix(".xml.part")
            started = dt.datetime.now(dt.timezone.utc).isoformat()
            with urllib.request.urlopen(request, timeout=120) as response, part.open("xb") as target:
                size = 0
                while data := response.read(1024 * 1024):
                    size += len(data)
                    if size > 1024 ** 3:
                        raise ValueError("unexpected payload over 1 GiB")
                    target.write(data)
                metadata = {"resolved_url": response.url, "last_modified": response.headers.get("Last-Modified"), "etag": response.headers.get("ETag")}
            details = inspect(part, title)
            part.rename(file)
            source = {"title": title, "url": url, **metadata, "file": file.as_posix(), "bytes": file.stat().st_size,
                      "sha256": digest(file), "acquired_at": started, **details}
            receipt.write_text(json.dumps(source, indent=2) + "\n", encoding="utf8")
        sources.append(source)
        print(json.dumps({key: source[key] for key in ["title", "bytes", "sha256", "xml_counts"]}), flush=True)
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    with args.lock.open("x", encoding="utf8") as target:
        json.dump({"schema_version": 1, "selection": "Complete eCFR Titles 21, 26, 40; fixed before conversion or timing; no duplicated documents",
                   "source_documentation": "https://www.govinfo.gov/developers", "sources": sources}, target, indent=2)
        target.write("\n")


if __name__ == "__main__":
    main()
