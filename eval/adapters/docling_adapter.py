"""Pinned offline parser adapter. No remote models or source publication."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

PINS = {"docling": "2.126.0"}


def coverage(status, page_range, input_pages, converted_pages):
    """Process completion, not transcription accuracy or OCR coverage."""
    complete = (status == "success" and page_range is None
                and isinstance(input_pages, int) and input_pages > 0
                and sorted(converted_pages) == list(range(1, input_pages + 1)))
    return "complete" if complete else "partial"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pages", help="Inclusive start:end, for explicitly partial comparison artifacts")
    args = parser.parse_args()
    page_range = None
    if args.pages:
        page_range = tuple(map(int, args.pages.split(":")))
        if len(page_range) != 2 or page_range[0] < 1 or page_range[1] < page_range[0]:
            parser.error("--pages must be an inclusive positive start:end range")
    packages = {name: importlib.metadata.version(name) for name in PINS}
    if packages != PINS:
        raise RuntimeError(f"Package pin mismatch: {packages}")
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    options = PdfPipelineOptions()
    options.do_ocr = False  # OCR requires separately reviewed local model selection.
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    kwargs = {"page_range": page_range} if page_range else {}
    result = converter.convert(args.input, raises_on_error=False, **kwargs)
    status = result.status.value
    converted_pages = sorted(result.document.pages)
    artifact = {"sect_adapter": {"version": "2", "packages": packages,
                "raw_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
                "page_range": args.pages, "conversion_status": status,
                "input_pages": result.input.page_count, "converted_pages": converted_pages,
                "coverage": coverage(status, page_range, result.input.page_count, converted_pages),
                "text_fidelity": "unverified", "ocr_enabled": False,
                "errors": [e.model_dump(mode="json") for e in result.errors]},
                "document": result.document.export_to_dict()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as target:
        json.dump(artifact, target, ensure_ascii=False)

if __name__ == "__main__":
    main()
