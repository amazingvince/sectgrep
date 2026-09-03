"""Ground truth from GovInfo CFR granule XML (the annual edition, the same text the per-section
PDF was typeset from). A granule is one section; its XML carries the printed page breaks
(PRTPAGE), the paragraphs in reading order (P, with E emphasis inline), the tables (GPOTABLE with
BOXHD/CHED headers and ROW/ENT cells), table notes (TNOTE) and the citation line (CITA).

Golden text = the blocks in order, one per line, tables excluded (tables are scored by TEDS on the
HTML built from GPOTABLE). Every block records the printed page it sits on so a page-level view is
possible; scoring clips a model's output to the section's span, since a page also carries the
neighbouring sections.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Block:
    kind: str  # heading | para | table | note | cita
    text: str
    page: int  # index within the granule's pages, 0-based
    html: str | None = None


@dataclass
class Golden:
    doc: str
    section: str
    title: str
    blocks: list[Block] = field(default_factory=list)

    @property
    def text_lines(self) -> list[str]:
        return [b.text for b in self.blocks if b.kind != "table" and b.text]

    @property
    def tables(self) -> list[Block]:
        return [b for b in self.blocks if b.kind == "table"]


WS = re.compile(r"\s+")


def norm_ws(s: str) -> str:
    return WS.sub(" ", s).strip()


def itertext(el: ET.Element) -> str:
    """All text under `el`, PRTPAGE markers skipped, whitespace collapsed."""
    parts: list[str] = []
    if el.text:
        parts.append(el.text)
    for child in el:
        if child.tag != "PRTPAGE":
            parts.append(itertext(child))
        if child.tail:
            parts.append(child.tail)
    return norm_ws("".join(parts))


def table_html(t: ET.Element) -> str:
    """GPOTABLE to a plain HTML table: header rows from BOXHD/CHED (one row per H level), body
    rows from ROW/ENT. Column spans are not encoded in GPOTABLE beyond the H hierarchy, so headers
    are emitted flat; TEDS compares structure and cell text, which is what a transcriber sees."""
    rows: list[str] = []
    boxhd = t.find("BOXHD")
    if boxhd is not None:
        levels: dict[str, list[str]] = {}
        for ched in boxhd.findall("CHED"):
            levels.setdefault(ched.get("H", "1"), []).append(itertext(ched))
        for h in sorted(levels, key=lambda x: int(x)):
            rows.append("<tr>" + "".join(f"<th>{c}</th>" for c in levels[h]) + "</tr>")
    for row in t.findall("ROW"):
        cells = [itertext(e) for e in row.findall("ENT")]
        rows.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
    return "<table>" + "".join(rows) + "</table>"


def parse_granule(path: Path, doc: str) -> Golden:
    root = ET.parse(path).getroot()
    section = root.find(".//SECTION")
    if section is None:
        raise ValueError(f"{path}: no SECTION")
    sectno = norm_ws(section.findtext("SECTNO") or "")
    subject = norm_ws(section.findtext("SUBJECT") or "")
    g = Golden(doc=doc, section=sectno, title=subject)
    page = 0
    # The first PRTPAGE inside the section marks the break to the granule's second page.
    g.blocks.append(Block("heading", norm_ws(f"{sectno} {subject}"), page))
    for el in section:
        if el.tag in ("SECTNO", "SUBJECT"):
            continue
        if el.tag == "PRTPAGE":
            page += 1
            continue
        # A PRTPAGE nested inside a paragraph means the paragraph straddles the break.
        nested = el.findall(".//PRTPAGE")
        if el.tag == "P" or el.tag == "FP" or el.tag == "HD" or el.tag == "EXTRACT":
            text = itertext(el)
            if text:
                g.blocks.append(Block("para" if el.tag != "HD" else "heading", text, page))
        elif el.tag == "GPOTABLE":
            g.blocks.append(Block("table", "", page, html=table_html(el)))
            for tn in el.findall("TNOTE"):
                text = itertext(tn)
                if text:
                    g.blocks.append(Block("note", text, page))
        elif el.tag == "CITA":
            g.blocks.append(Block("cita", itertext(el), page))
        elif el.tag in ("NOTE", "AUTH"):
            text = itertext(el)
            if text:
                g.blocks.append(Block("note", text, page))
        page += len(nested)
    return g


def write_golden(g: Golden, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{g.doc}.json").write_text(json.dumps({"doc": g.doc, "section": g.section, "title": g.title, "blocks": [asdict(b) for b in g.blocks]}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md = [f"# {g.section} {g.title}", "", "<!-- hand-checkable golden: one block per line in reading order; tables as HTML; page index in brackets -->", ""]
    for b in g.blocks:
        if b.kind == "table":
            md.append(f"[p{b.page}] {b.html}")
        else:
            md.append(f"[p{b.page}] {b.text}")
    (out_dir / f"{g.doc}.md").write_text("\n".join(md) + "\n", encoding="utf-8")
