"""The document set (spec C0, GOAL.md G-D): 10 born-digital eCFR granules, 10 granules with
tables, 10 scanned pre-1994 Federal Register pages. Everything under raw/bakeoff/ is fetched by
script (GovInfo link service and bulk PDFs); the golden files under eval/golden/bakeoff/ are
generated from the granule XML for the first two groups and are consensus-derived for the scans,
which have no text layer (marked as such, to be hand-checked).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .golden import parse_granule, write_golden

ROOT = Path(__file__).resolve().parents[4]
RAW = ROOT / "raw" / "bakeoff"
GOLDEN = ROOT / "eval" / "golden" / "bakeoff"

BORN = ["1904.2", "1904.10", "1910.24", "1910.27", "1910.37", "1910.159", "1910.331", "1910.401", "1910.423", "1910.34"]
TABLES = ["1915.118", "1910.133", "1915.153", "1926.102", "1471.25", "779.4", "1926.56", "1919.37", "1918.4", "1917.121"]
SCANS = [("FR-1975-03-03", [12, 20, 33, 47, 60]), ("FR-1985-06-03", [6, 15, 25, 40, 55])]
SCAN_NATIVE_DPI = 100


def page_count(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    raise RuntimeError(f"pdfinfo: no page count for {pdf}")


def build() -> dict:
    docs = []
    for group, secs in (("born", BORN), ("table", TABLES)):
        for s in secs:
            part, sec = s.split(".", 1)
            stem = f"29-{part}-{sec}"
            pdf = RAW / "cfr" / f"{stem}.pdf"
            xml = RAW / "cfr" / f"{stem}.xml"
            g = parse_granule(xml, stem)
            write_golden(g, GOLDEN / group)
            docs.append({
                "doc": stem, "group": group, "pdf": str(pdf.relative_to(ROOT)), "pages": list(range(1, page_count(pdf) + 1)),
                "golden": str((GOLDEN / group / f"{stem}.json").relative_to(ROOT)), "section": g.section, "tables": len(g.tables), "native_dpi": None,
            })
    for issue, pages in SCANS:
        for p in pages:
            docs.append({
                "doc": f"{issue}-p{p}", "group": "scan", "pdf": str((RAW / "fr" / f"{issue}.pdf").relative_to(ROOT)), "pages": [p],
                "golden": str((GOLDEN / "scan" / f"{issue}-p{p}.json").relative_to(ROOT)), "section": None, "tables": 0, "native_dpi": SCAN_NATIVE_DPI,
            })
    manifest = {"docs": docs, "pages_total": sum(len(d["pages"]) for d in docs)}
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest
