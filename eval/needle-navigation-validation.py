"""Independently resolve native locators and check canonical passage expansion.

This checks bytes, addresses and API behavior. It creates no human judgments.
Uses the current Linux validation executable through WSL for both isolated corpora.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BIN = "/home/amazi/sect/target/debug/sect"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(corpus, *args):
    wsl_path = "/mnt/" + str(corpus.resolve()).replace("\\", "/").replace(":", "").replace("C/", "c/", 1)
    result = subprocess.run(["wsl", "-d", "Ubuntu-24.04-CUDA", "--", BIN, "--corpus", wsl_path, "--no-refresh", *args, "--json"], check=True, capture_output=True, encoding="utf8")
    return json.loads(result.stdout)["result"]


def generation(corpus):
    selected = sorted((corpus / ".sect/published").glob("*.ready"))[-1].stem
    return selected, corpus / ".sect/generations" / selected


def main():
    capture_path = ROOT / "review/needle-retrieval/docling-attention-v2.json"
    capture = json.loads(capture_path.read_text(encoding="utf8"))
    outputs = []
    for name, artifact in [
        ("needle-native-office-v1", "fixtures/laboratory-archive.document.json"),
        ("needle-docling-attention-v3", "research/attention-v7.document.json"),
    ]:
        corpus = ROOT / "corpora" / name
        gen, directory = generation(corpus)
        source_file = directory / "corpus" / artifact
        source = json.loads(source_file.read_text(encoding="utf8"))
        raw = (directory / "corpus" / source["raw"]).read_bytes()
        assert digest(raw) == source["raw_sha256"]
        checked, locations, reads = [], 0, {}
        for region in source["regions"]:
            loc = region["locator"]
            if loc["type"] == "office":
                with zipfile.ZipFile(io.BytesIO(raw)) as package:
                    node = ET.fromstring(package.read(loc["part"]))
                steps = re.findall(r"/\*\[(\d+)\]", loc["xpath"])
                assert steps and "".join(f"/*[{s}]" for s in steps) == loc["xpath"] and steps[0] == "1"
                for position in steps[1:]:
                    node = list(node)[int(position) - 1]
                text = "".join(n.text or "" if n.tag == W + "t" else " " if n.tag in [W + "br", W + "cr", W + "tab"] else "" for n in node.iter())
                assert " ".join(text.split()) == region["text"]
                locations += 1
            elif loc["type"] == "pages":
                assert source["raw_sha256"] == capture["sect_adapter"]["raw_sha256"]
                matches = [x for x in capture["document"]["texts"] if (x.get("text") or x.get("orig")) == region["text"]]
                assert len(matches) == 1
                expected = []
                for p in matches[0]["prov"]:
                    b = p["bbox"]
                    height = capture["document"]["pages"][str(p["page_no"])]["size"]["height"]
                    box = [b["l"], height - b["t"], b["r"], height - b["b"]] if b["coord_origin"] == "BOTTOMLEFT" else [b["l"], b["t"], b["r"], b["b"]]
                    expected.append({"page": p["page_no"], "bbox": box, "elements": [region["order"]]})
                assert loc["locations"] == expected
                locations += len(expected)
            else:
                continue
            unit = next(u for u in source["units"] if region["id"] in u["regions"])
            expr = unit["id"] + "@" + source["effective"]
            if expr not in reads:
                reads[expr] = command(corpus, "read", expr)
            assert any(r["id"] == region["id"] and r["locator"] == loc for r in reads[expr]["source_regions"]), (name, expr, region["id"], region["order"], reads[expr]["source_region_count"], reads[expr]["source_regions"])
            checked.append(region["id"])
        assert len(checked) == 6
        chunks = [json.loads(line) for line in (directory / "chunks.jsonl").read_text(encoding="utf8").splitlines()]
        selected = next(c for c in chunks if not c["navigation"] and c["spans"])
        expanded = command(corpus, "read", selected["chunk_id"])
        assert expanded["passage"]["body"] == selected["body"]
        assert expanded["passage"]["spans"] == selected["spans"]
        sections = [expanded] + expanded["passage"]["additional_sections"]
        assert {s["expr"] for s in sections} == {s["expr"] for s in selected["spans"]}
        for section in sections:
            canonical = command(corpus, "read", section["expr"])
            assert canonical["body"] == section["body"]
        outputs.append({"corpus": name, "generation": gen, "raw_sha256": source["raw_sha256"], "document_artifact_sha256": digest(source_file.read_bytes()), "checked_regions": checked, "native_locations": locations, "canonical_reads": len(reads), "passage_expansion": True})
    output = {"purpose": "source-navigation integrity", "independently_judged": False, "capture_sha256": digest(capture_path.read_bytes()), "cases": outputs, "limitations": ["Word fixture covers unique plain-text paragraphs; ambiguous and complex Office constructs remain flagged.", "Docling grouped boxes preserve their union without asserting per-box character alignment.", "No extraction accuracy or relevance qualification is implied."]}
    destination = ROOT / "eval/results/needle-navigation-2026-09-05.json"
    destination.write_text(json.dumps(output, indent=2) + "\n", encoding="utf8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
