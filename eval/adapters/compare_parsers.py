"""Pinned Docling comparison on the exact extraction-review sample. No human gold."""
import argparse
import hashlib
import importlib.metadata
import json
import re
import time
from pathlib import Path


def normalize(text):
    return " ".join(text.split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reviews", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if importlib.metadata.version("docling") != "2.126.0":
        raise ValueError("Docling pin mismatch")
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    options = PdfPipelineOptions()
    options.do_ocr = False
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    args.output.mkdir(parents=True, exist_ok=True)
    reviews = json.loads(args.reviews.read_text(encoding="utf-8"))["items"]
    rows, cache = [], {}
    for reviewed in reviews:
        item = reviewed["item"]
        if item["kind"] != "extraction":
            continue
        source = item["source"][0]
        file = Path(source["file"])
        row = {"item": item["id"], "domain": item["domain"], "source_sha256": source["sha256"],
               "native": item["proposal"], "locator": source["locator"], "human_selection": None}
        if hashlib.sha256(file.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("source changed")
        if file.suffix.lower() not in {".pdf", ".html", ".htm"}:
            row.update(status="unsupported_comparator_format", reason="Native XML/JATS retained; no derived conversion counted as independent evidence")
            rows.append(row)
            continue
        page = source["locator"].get("page") if file.suffix.lower() == ".pdf" else None
        key = f'{source["sha256"]}-{page or "full"}'
        output = args.output / f"{key}.docling.json"
        started = time.perf_counter()
        try:
            if key not in cache:
                if output.exists():
                    artifact = json.loads(output.read_text(encoding="utf-8"))
                else:
                    result = converter.convert(file, **({"page_range": (page, page)} if page else {}))
                    artifact = {"sect_adapter": {"version": "1", "packages": {"docling": "2.126.0"},
                                "raw_sha256": source["sha256"], "coverage": "partial" if page else "complete", "page_range": [page, page] if page else None},
                                "document": result.document.export_to_dict()}
                    output.write_text(json.dumps(artifact, ensure_ascii=False), encoding="utf-8")
                cache[key] = artifact
            document = cache[key]["document"]
            texts = [x.get("text", "") for x in document.get("texts", [])]
            texts += [" ".join(c.get("text", "") for c in t.get("data", {}).get("table_cells", [])) for t in document.get("tables", [])]
            combined = normalize(" ".join(texts))
            native = normalize(source["text"])
            protected = re.findall(r"\b(?:\d+(?:[.,]\d+)*%?|not|no|except|unless|must|shall)\b", native, re.I)
            row.update(status="compared", docling_artifact=str(output), docling_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                       exact_native_text_present=native in combined, protected_tokens_missing=[x for x in protected if x not in combined],
                       docling_text_items=len(texts), docling_tables=len(document.get("tables", [])),
                       comparison_seconds=time.perf_counter()-started)
        except Exception as error:
            row.update(status="comparator_failed", reason=str(error))
        rows.append(row)
        print(f'{len(rows)}: {file.name} page {page}: {row["status"]}', flush=True)
        (args.output / "comparison.json").write_text(json.dumps({"schema_version": 1, "purpose": "parser agreement diagnostics; human selection required", "rows": rows}, indent=2), encoding="utf-8")
    result = {"schema_version": 1, "purpose": "parser agreement diagnostics; human selection required", "rows": rows}
    (args.output / "comparison.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
