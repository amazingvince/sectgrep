"""Scores (spec C0, C.3 selection criterion: TextEdit and reading order over table TEDS).

TextEdit: normalized Levenshtein distance between the model's text and the golden text after
the same normalization on both sides (markdown syntax and tables stripped, whitespace collapsed),
0 is perfect. The model output is first clipped to the section's span, because a printed page
carries the neighbouring sections and running heads that the golden section does not.

Reading order: each golden block is located in the model output by fuzzy partial match; the
order the model gives those blocks is compared with the golden order by normalized Levenshtein
over the block sequence (0 is perfect); unmatched blocks are reported as a miss rate.

TEDS: tree edit distance similarity between the golden table (HTML from GPOTABLE) and the model's
table (HTML or a markdown pipe table), cell text compared by normalized edit distance; 1 is
perfect. Tables are paired in document order; a missing table scores 0.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from html.parser import HTMLParser

from apted import APTED, Config
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein

RUNNING_HEADS = [
    re.compile(r"^\s*\d{1,4}\s*$"),
    re.compile(r"29 CFR Ch\. XVII", re.I),
    re.compile(r"^#*\s*Occu\.? ?(pational)? Safety and Health Admin", re.I),
    re.compile(r"^#*\s*§\s*\d+\.\d+[a-z]?\s*$"),
    re.compile(r"\(7-1-2\d Edition\)", re.I),
    re.compile(r"^VerDate|^Jkt \d|^PO 0000|^Frm \d|^Sfmt \d|^Fmt \d", re.I),
    # GPO typesetting margin text that extractors read off the page edge.
    re.compile(r"on DSK\w+ with CFR|[A-Z]:\\SGML\\|\.XXX \d{5,}", re.I),
    # The GPO authenticity banner at the top of every GovInfo page (models misread it in ways).
    re.compile(r"AUTHENTICATED U.S. GOVERNMENT INFORMATION|^GPO$|^#+ ?GPO$", re.I),
    re.compile(r"^---\s*$"),
]
DASHES = re.compile(r"[\u2010\u2011\u2012\u2013\u2014\u2212]")
SECTION_HEAD = re.compile(r"(?:§|Sec\.?|Section)\s*(\d+\.\d+[a-z]?)", re.I)
# Headings that end a section's span without being another section: appendices and subparts.
OTHER_HEAD = re.compile(r"^#*\s*(Appendix|APPENDIX|Subpart|SUBPART|PART \d)", re.I)


IMAGE_MD = re.compile(r"!\[[^\]]*\]\([^)]*\)")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    # Embedded images (Docling's markdown export inlines them as base64) are not text.
    text = IMAGE_MD.sub(" ", text)
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("|") or "data:image" in s or re.match(r"^<\s*/?\s*(table|tr|td|th|thead|tbody|img)\b", s, re.I):
            continue
        if any(p.search(s) for p in RUNNING_HEADS):
            continue
        s = re.sub(r"^#{1,6}\s+", "", s)
        s = re.sub(r"[*_`]{1,3}", "", s)
        s = re.sub(r"<[^>]+>", " ", s)
        s = re.sub(r"§\s*", "§ ", s)
        s = DASHES.sub("-", s)
        # Spacing around a dash is typography, not text: "systems -(1)" and "systems-(1)" agree.
        s = re.sub(r"\s*-\s*", "-", s)
        out.append(s)
    return re.sub(r"\s+", " ", " ".join(out)).strip()


FRONT_MATTER = re.compile(r"(?:^|\n)\s*---\s*\n(?:[a-z_]+:[^\n]*\n){1,8}---\s*\n", re.S)


def strip_front_matter(text: str) -> str:
    """olmOCR-style YAML front matter (primary_language, is_rotation_valid, ...) at the top of
    every page; pages are joined, so every block goes, not only the first."""
    return FRONT_MATTER.sub("\n", text)


def clip_to_section(text: str, section: str | None) -> str:
    """Keep the span from the section's own heading to the next section heading."""
    if not section:
        return text
    m = re.search(r"(\d+\.\d+[a-z]?)", section)
    if not m:
        return text
    num = m.group(1)
    lines = text.splitlines()
    start = None
    # The section's own heading carries its title after the number; a bare "§ 1910.34" line is
    # the running head at the top of a page. Prefer the former, fall back to the latter.
    for want_title in (True, False):
        for i, line in enumerate(lines):
            t = line.strip()
            h = SECTION_HEAD.search(t)
            if not h or h.group(1) != num:
                continue
            if any(p.search(t) for p in RUNNING_HEADS):
                continue
            after = t[h.end():].strip(" .:-*")
            if want_title and len(after) < 4:
                continue
            if len(t) < 160 or t.startswith(("§", "Sec", "#")):
                start = i
                break
        if start is not None:
            break
    if start is None:
        return text
    end = len(lines)
    for j in range(start + 1, len(lines)):
        t = lines[j].strip()
        if OTHER_HEAD.match(t) and len(t) < 120:
            end = j
            break
        h = SECTION_HEAD.search(t)
        if not h or h.group(1) == num:
            continue
        # A bare "§ 1910.28" is the running head of a continuation page, not the next section;
        # the real heading carries the section's title after the number.
        after = t[h.end():].strip(" .:-")
        if len(after) < 4:
            continue
        if (t.startswith(("§", "#", "Sec")) or len(t) < 80) and not re.search(r"paragraph|see|of this|under|in §|to §|and §|or §", t, re.I):
            end = j
            break
    return "\n".join(lines[start:end])


def clip_to_golden(text: str, gold_lines: list[str]) -> str | None:
    """Anchor the span on the golden text itself: the output line that best matches the golden's
    first substantial block starts it, the line that best matches one of its last blocks ends it.
    Independent of how a model wrote the heading. None when the anchors are not found."""
    lines = text.splitlines()
    nl = [normalize(l) for l in lines]

    def best(probe: str, lo: int = 0) -> tuple[int, int] | None:
        probe = probe[:120]
        cands = [(fuzz.partial_ratio(probe, l) if len(l) >= 10 else 0, i) for i, l in enumerate(nl) if i >= lo]
        if not cands:
            return None
        score, i = max(cands)
        return (score, i) if score >= 75 else None

    firsts = [normalize(g) for g in gold_lines if len(normalize(g)) >= 40][:3]
    lasts = [normalize(g) for g in reversed(gold_lines) if len(normalize(g)) >= 40][:3]
    if not firsts:
        return None
    # A model may drop the heading: anchor on the earliest of the first three blocks it did keep.
    starts = [b for b in (best(g) for g in firsts) if b]
    if not starts:
        return None
    start_i = min(i for _, i in starts)
    ends = [b for b in (best(g, start_i) for g in lasts) if b]
    end = max(i for _, i in ends) if ends else len(lines) - 1
    return "\n".join(lines[start_i:end + 1])


def text_edit(pred: str, gold_lines: list[str]) -> float:
    g = normalize(" \n".join(gold_lines))
    p = normalize(pred)
    if not g and not p:
        return 0.0
    return Levenshtein.normalized_distance(p, g)


@dataclass
class ReadingOrder:
    distance: float
    matched: int
    total: int

    @property
    def miss_rate(self) -> float:
        return 1 - self.matched / self.total if self.total else 0.0


def reading_order(pred: str, gold_lines: list[str]) -> ReadingOrder:
    blocks = [normalize(b) for b in gold_lines]
    blocks = [(i, b) for i, b in enumerate(blocks) if len(b) >= 15]
    pred_lines = [normalize(l) for l in pred.splitlines()]
    pred_lines = [(j, l) for j, l in enumerate(pred_lines) if l]
    if not blocks or not pred_lines:
        return ReadingOrder(1.0, 0, len(blocks))
    placed: list[tuple[int, int]] = []  # (pred position, golden index)
    for gi, b in blocks:
        best, best_j = 0.0, None
        probe = b[:120]
        for j, l in pred_lines:
            s = fuzz.partial_ratio(probe, l) if len(l) >= 8 else 0.0
            if s > best:
                best, best_j = s, j
        if best >= 70 and best_j is not None:
            placed.append((best_j, gi))
    if not placed:
        return ReadingOrder(1.0, 0, len(blocks))
    pred_order = [gi for _, gi in sorted(placed)]
    gold_order = sorted(pred_order)
    dist = Levenshtein.normalized_distance(pred_order, gold_order)
    return ReadingOrder(dist, len(placed), len(blocks))


# ---- TEDS ------------------------------------------------------------------------------------

@dataclass
class Node:
    tag: str
    text: str = ""
    children: list["Node"] = field(default_factory=list)


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[Node] = []
        self.stack: list[Node] = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "table":
            n = Node("table")
            self.tables.append(n)
            self.stack = [n]
        elif tag in ("tr", "td", "th", "thead", "tbody") and self.stack:
            n = Node("td" if tag == "th" else tag)
            if tag in ("thead", "tbody"):
                return
            self.stack[-1].children.append(n)
            self.stack.append(n)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "table":
            self.stack = []
        elif tag in ("tr", "td", "th") and len(self.stack) > 1:
            want = "td" if tag == "th" else tag
            while len(self.stack) > 1 and self.stack[-1].tag != want:
                self.stack.pop()
            if len(self.stack) > 1:
                self.stack.pop()

    def handle_data(self, data):
        if self.stack and self.stack[-1].tag == "td":
            self.stack[-1].text += data


def markdown_tables_to_html(text: str) -> str:
    """Pipe tables (what olmOCR and Docling emit) become HTML tables; other text is kept."""
    out, rows = [], []

    def flush():
        nonlocal rows
        if rows:
            body = "".join("<tr>" + "".join(f"<td>{c.strip()}</td>" for c in r) + "</tr>" for r in rows)
            out.append(f"<table>{body}</table>")
            rows = []

    for line in text.splitlines():
        s = line.strip()
        if s.startswith("|") and s.endswith("|"):
            cells = s.strip("|").split("|")
            if all(re.fullmatch(r"\s*:?-{2,}:?\s*", c) for c in cells):
                continue
            rows.append(cells)
        else:
            flush()
            out.append(line)
    flush()
    return "\n".join(out)


def parse_tables(html_or_md: str) -> list[Node]:
    p = _TableParser()
    p.feed(markdown_tables_to_html(html_or_md))
    for t in p.tables:
        _strip(t)
    return p.tables


def _strip(n: Node) -> None:
    n.text = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", n.text)).strip()
    for c in n.children:
        _strip(c)


class _TedsConfig(Config):
    def rename(self, n1: Node, n2: Node) -> float:
        if n1.tag != n2.tag:
            return 1.0
        if n1.tag == "td":
            return Levenshtein.normalized_distance(n1.text, n2.text)
        return 0.0

    def children(self, node: Node):
        return node.children


def _size(n: Node) -> int:
    return 1 + sum(_size(c) for c in n.children)


def teds(pred: Node, gold: Node) -> float:
    dist = APTED(pred, gold, _TedsConfig()).compute_edit_distance()
    return 1.0 - dist / max(_size(pred), _size(gold))


def teds_for_doc(pred_text: str, gold_tables_html: list[str]) -> list[float]:
    """Pair tables in document order; a golden table with no prediction scores 0."""
    preds = parse_tables(pred_text)
    golds = [t for h in gold_tables_html for t in parse_tables(h)]
    scores = []
    for i, g in enumerate(golds):
        if i < len(preds):
            # Choose the best remaining prediction near position i (models sometimes merge or split).
            cands = preds[max(0, i - 1): i + 2]
            scores.append(max(teds(p, g) for p in cands))
        else:
            scores.append(0.0)
    return scores
