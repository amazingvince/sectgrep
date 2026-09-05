"""Capture a version-pinned local GROBID comparison with TEI coordinates and raw identity.

Requires an already running local service. Original source bytes never go to a hosted API.
The output is a comparison artifact, not an automatic production parser replacement.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input",type=Path)
    parser.add_argument("output",type=Path)
    parser.add_argument("--service",default="http://127.0.0.1:8070")
    parser.add_argument("--expected-version",required=True)
    args=parser.parse_args()
    url=urllib.parse.urlparse(args.service)
    if url.hostname not in {"127.0.0.1","localhost","::1"} or url.scheme!="http":
        raise ValueError("comparison service must be local loopback HTTP")
    if args.output.exists():
        raise ValueError("retain existing comparison artifacts; choose a new output")
    service=args.service.rstrip("/")
    version=urllib.request.urlopen(service+"/api/version",timeout=5).read().decode().strip().strip('"')
    if version!=args.expected_version:
        raise ValueError(f"GROBID version mismatch: {version}")
    boundary="sect-"+uuid.uuid4().hex
    raw=args.input.read_bytes()
    parts=[]
    def field(name,value):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name,value in [("consolidateHeader","0"),("consolidateCitations","0"),("includeRawCitations","1")]:
        field(name,value)
    for element in ["head","p","s","formula","figure","ref","biblStruct"]:
        field("teiCoordinates",element)
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="input"; filename="source.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()+raw+b"\r\n")
    parts.append(f'--{boundary}--\r\n'.encode())
    request=urllib.request.Request(service+"/api/processFulltextDocument",data=b"".join(parts),headers={"Content-Type":f"multipart/form-data; boundary={boundary}"})
    started=time.perf_counter()
    tei=urllib.request.urlopen(request,timeout=180).read().decode("utf8")
    tree=ET.fromstring(tei)
    records=[{"type":e.tag.rsplit("}",1)[-1],"coords":e.attrib.get("coords"),"text":"".join(e.itertext())} for e in tree.iter() if e.attrib.get("coords")]
    artifact={"sect_adapter":{"version":"1","parser":"grobid","service_version":version,"raw_sha256":hashlib.sha256(raw).hexdigest(),"coverage":"complete","elapsed_ms":(time.perf_counter()-started)*1000},"tei":tei,"located_regions":records}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open("x",encoding="utf8") as out:
        json.dump(artifact,out,ensure_ascii=False,indent=2)

if __name__=="__main__":
    main()
