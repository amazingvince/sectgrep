"""Corpus loader for the spec B.2 contract plus the deterministic structural graph.

Everything structural (tree, cross-references, Actions, terms, tables, precedence, Work /
Expression / Action versioning) comes from front matter and markdown, never from a model.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

FRONT_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)
LINK_RE = re.compile(r"\[([^\]]*)\]\(([A-Z]+:[^)#\s]+)(?:#([^)\s]+))?\)")
LABEL_RE = re.compile(r"^\(([a-z]{1,4}|\d{1,2})\)\s")
TABLE_SEP_RE = re.compile(r"^\|?\s*:?-{3,}")
ROMAN = {"ii", "iii", "iv", "vi", "vii", "viii", "ix"}
STOPWORDS = frozenset(
    """a an the of to in on for and or by at as is are be been shall may must with within from that
    this than its it their each any all not no under over which when where who whose what how does do
    did then also into if per such other there here about between during after before against can
    has have had was were will would should could need needs required requirement requirements""".split()
)
LEVEL_LABEL = {"title": "Title", "chapter": "Chapter", "subchapter": "Subchapter", "part": "Part"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9][a-z0-9.\-]*[a-z0-9]|[a-z0-9]", text.lower())


def content_words(text: str) -> list[str]:
    return [w for w in words(text) if w not in STOPWORDS and len(w) > 1]


def parse_date(value) -> dt.date | None:
    if value is None or value == "":
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    return dt.date.fromisoformat(str(value)[:10])


def strip_links(text: str) -> str:
    return LINK_RE.sub(lambda m: m.group(1), text)


@dataclass
class Source:
    name: str
    kind: str
    precedence: int
    id_prefix: str
    id_pattern: re.Pattern | None
    id_template: str | None
    anchor_template: str | None
    legal_status: str
    title: str
    path: Path

    @classmethod
    def load(cls, path: Path) -> "Source":
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        pat = raw.get("id_pattern")
        return cls(
            name=raw["name"],
            kind=raw.get("kind", "base"),
            precedence=int(raw.get("precedence", 0)),
            id_prefix=raw.get("id_prefix", ""),
            id_pattern=re.compile(pat) if pat else None,
            id_template=raw.get("id_template"),
            anchor_template=raw.get("anchor_template"),
            legal_status=raw.get("legal_status", "derived"),
            title=raw.get("title", raw["name"]),
            path=path.parent,
        )


@dataclass
class Table:
    header: list[str]
    rows: list[list[str]]

    def flat_rows(self) -> list[str]:
        return ["; ".join(f"{h}: {c}" for h, c in zip(self.header, row)) for row in self.rows]


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_tables(body: str) -> list[Table]:
    lines = body.splitlines()
    tables: list[Table] = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("|") and i + 1 < len(lines) and TABLE_SEP_RE.match(lines[i + 1].strip()):
            header = _cells(line)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(_cells(lines[i]))
                i += 1
            tables.append(Table(header, rows))
        else:
            i += 1
    return tables


def parse_paragraph_anchors(body: str) -> list[str]:
    """Paragraph labels (a), (1), (i) become anchors a, a-1, a-1-i."""
    anchors: list[str] = []
    lvl1: str | None = None
    lvl2: str | None = None
    for raw in body.splitlines():
        m = LABEL_RE.match(raw.strip())
        if not m:
            continue
        lab = m.group(1)
        if lab.isdigit():
            lvl2 = lab
            anchors.append(f"{lvl1}-{lab}" if lvl1 else lab)
        elif lab in ROMAN and lvl2 is not None:
            anchors.append(f"{lvl1}-{lvl2}-{lab}")
        else:
            lvl1, lvl2 = lab, None
            anchors.append(lab)
    return anchors


@dataclass
class Section:
    id: str
    expr: str
    path: Path
    source: Source
    front: dict
    body: str
    title: str
    level: str
    kind: str
    parent: str | None
    order: int
    effective: dt.date | None
    supersedes: str | None
    superseded_by: str | None
    amended_by: list[str]
    overrides: list[str]
    narrows: list[dict]
    defines: list[str]
    context: str
    node: str | None
    tags: list[str]
    actions: list[dict]
    links: list[tuple[str, str | None]]
    paragraph_anchors: list[str]
    tables: list[Table]
    breadcrumb: str = ""
    label: str = ""

    @classmethod
    def load(cls, path: Path, source: Source) -> "Section":
        text = path.read_text(encoding="utf-8")
        m = FRONT_RE.match(text)
        if not m:
            raise ValueError(f"{path}: missing front matter")
        front = yaml.safe_load(m.group(1)) or {}
        body = text[m.end():].strip("\n")
        eff = parse_date(front.get("effective"))
        sid = str(front["id"])
        links = [(t, a) for _, t, a in LINK_RE.findall(body)]
        links = [(t, a or None) for t, a in links]
        return cls(
            id=sid,
            expr=f"{sid}@{eff.isoformat()}" if eff else sid,
            path=path,
            source=source,
            front=front,
            body=body,
            title=str(front.get("title", "")),
            level=str(front.get("level", "section")),
            kind=str(front.get("kind", source.kind)),
            parent=front.get("parent"),
            order=int(front.get("order", 0) or 0),
            effective=eff,
            supersedes=front.get("supersedes"),
            superseded_by=front.get("superseded_by"),
            amended_by=list(front.get("amended_by") or []),
            overrides=list(front.get("overrides") or []),
            narrows=list(front.get("narrows") or []),
            defines=[str(t) for t in (front.get("defines") or [])],
            context=" ".join(str(front.get("context", "")).split()),
            node=front.get("node"),
            tags=[str(t) for t in (front.get("tags") or [])],
            actions=list(front.get("actions") or []),
            links=links,
            paragraph_anchors=parse_paragraph_anchors(body),
            tables=parse_tables(body),
        )

    @property
    def anchors(self) -> list[str]:
        return self.paragraph_anchors + [slug(t) for t in self.defines]

    @property
    def body_plain(self) -> str:
        return strip_links(self.body)

    @property
    def link_targets(self) -> list[str]:
        return [t for t, _ in self.links]


class Corpus:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.sources: dict[str, Source] = {}
        self.sections: list[Section] = []
        for src_dir in sorted(p for p in self.root.iterdir() if p.is_dir()):
            sy = src_dir / "_source.yaml"
            if not sy.exists():
                continue
            src = Source.load(sy)
            self.sources[src.name] = src
            for md in sorted(src_dir.rglob("*.md")):
                self.sections.append(Section.load(md, src))
        self._build()

    # ---- graph construction -------------------------------------------------------------
    def _build(self) -> None:
        self.by_expr: dict[str, Section] = {}
        self.works: dict[str, list[Section]] = {}
        for s in self.sections:
            self.by_expr[s.expr] = s
            self.works.setdefault(s.id, []).append(s)
        for exprs in self.works.values():
            exprs.sort(key=lambda s: (s.effective or dt.date.min))
        self.current: dict[str, Section] = {}
        for wid, exprs in self.works.items():
            live = [s for s in exprs if not s.superseded_by]
            self.current[wid] = live[-1] if live else exprs[-1]
        self.children: dict[str, list[Section]] = {}
        for s in self.current.values():
            if s.parent:
                self.children.setdefault(s.parent, []).append(s)
        for kids in self.children.values():
            kids.sort(key=lambda s: s.order)
        # edges: (from_id, to_id, anchor, type)
        self.edges: list[tuple[str, str, str | None, str]] = []
        for s in self.sections:
            for t, a in s.links:
                self.edges.append((s.id, t, a, "references"))
            for t in s.overrides:
                self.edges.append((s.id, t, None, "overrides"))
            for n in s.narrows:
                self.edges.append((s.id, n["id"], n.get("anchor"), "narrows"))
            if s.supersedes:
                self.edges.append((s.expr, s.supersedes, None, "supersedes"))
            for a in s.amended_by:
                self.edges.append((a, s.id, None, "amends"))
            for t in s.defines:
                self.edges.append((s.id, f"term:{slug(t)}", None, "defines"))
        self.refs_in_count: dict[str, int] = {}
        for f, t, _, typ in self.edges:
            if typ in ("references", "overrides", "narrows") and f != t:
                self.refs_in_count[t] = self.refs_in_count.get(t, 0) + 1
        self.terms: dict[str, tuple[str, str]] = {}
        for s in self.current.values():
            for t in s.defines:
                self.terms[" ".join(words(t))] = (s.id, slug(t))
        self.actions: list[dict] = []
        for s in self.sections:
            for a in s.actions:
                self.actions.append({**a, "notice": a.get("notice", s.id)})
        self.actions_by_id = {a["action_id"]: a for a in self.actions}
        self.overridden_by: dict[str, list[str]] = {}
        self.narrowed_by: dict[str, list[dict]] = {}
        for s in self.current.values():
            for t in s.overrides:
                self.overridden_by.setdefault(t, []).append(s.id)
            for n in s.narrows:
                self.narrowed_by.setdefault(n["id"], []).append({"id": s.id, "anchor": n.get("anchor")})
        for s in self.sections:
            s.label = self._label(s)
            s.breadcrumb = self._breadcrumb(s)

    def _label(self, s: Section) -> str:
        tail = s.id[len(s.source.id_prefix):] if s.id.startswith(s.source.id_prefix) else s.id
        if s.source.kind == "base":
            num = tail.split("-")[-1]
            if s.level == "section":
                return f"§ {num}"
            return f"{LEVEL_LABEL.get(s.level, s.level.title())} {num}"
        return tail

    def _breadcrumb(self, s: Section) -> str:
        if s.source.kind == "base":
            chain = [s]
            cur = s
            seen = set()
            while cur.parent and cur.parent in self.current and cur.parent not in seen:
                seen.add(cur.parent)
                cur = self.current[cur.parent]
                chain.append(cur)
            parts = []
            for node in reversed(chain):
                parts.append(f"{node.label} {node.title}".strip())
            return " > ".join(parts)
        head = {"overlay": "Local amendments", "notice": "Fixture Register", "note": "Notes"}.get(
            s.source.kind, s.source.kind
        )
        return f"{head} > {s.label} {s.title}".strip()

    # ---- lookups ------------------------------------------------------------------------
    def section(self, ref: str) -> Section | None:
        """Resolve a Work id or an Expression id."""
        if ref in self.by_expr:
            return self.by_expr[ref]
        return self.current.get(ref)

    def as_of(self, wid: str, date: dt.date) -> Section | None:
        """Snap to the nearest published Expression on or before date (spec B.4)."""
        cands = [s for s in self.works.get(wid, []) if s.effective and s.effective <= date]
        return cands[-1] if cands else None

    def active(self, s: Section, as_of: dt.date | None, include_superseded: bool) -> bool:
        if as_of is None:
            return include_superseded or not s.superseded_by
        if include_superseded:
            return bool(s.effective and s.effective <= as_of)
        snapped = self.as_of(s.id, as_of)
        return snapped is not None and snapped.expr == s.expr

    def ancestors(self, wid: str) -> list[Section]:
        out = []
        cur = self.current.get(wid)
        while cur and cur.parent and cur.parent in self.current:
            cur = self.current[cur.parent]
            out.append(cur)
        return out

    def map_complete(self, wid: str, anchor: str | None = None) -> list[str]:
        """Full subtree by traversal: child section ids for a container, else paragraph anchors."""
        s = self.current.get(wid)
        if s is None:
            return []
        if anchor:
            return [a for a in s.paragraph_anchors if a.startswith(f"{anchor}-")]
        if wid in self.children:
            out: list[str] = []

            def rec(i: str) -> None:
                for c in self.children.get(i, []):
                    out.append(c.id)
                    rec(c.id)

            rec(wid)
            return out
        return [a for a in s.paragraph_anchors if "-" not in a]

    def history(self, wid: str) -> list[str]:
        out: list[str] = []
        for i, e in enumerate(self.works.get(wid, [])):
            if i > 0:
                out.extend(e.amended_by)
            out.append(e.expr)
        return out

    def refs(self, ref: str, direction: str = "out", typ: str | None = None, depth: int = 1) -> list[dict]:
        wid = ref.split("@")[0]
        seen = {wid}
        frontier = [wid]
        out: list[dict] = []
        for d in range(1, max(1, min(depth, 5)) + 1):
            nxt = []
            for cur in frontier:
                for f, t, a, et in self.edges:
                    if typ and et != typ:
                        continue
                    hit = None
                    if direction in ("out", "both") and f.split("@")[0] == cur:
                        hit = {"from": f, "to": t, "anchor": a, "type": et, "depth": d}
                        other = t
                    elif direction in ("in", "both") and t.split("@")[0] == cur:
                        hit = {"from": f, "to": t, "anchor": a, "type": et, "depth": d}
                        other = f.split("@")[0]
                    else:
                        continue
                    out.append(hit)
                    if other not in seen and not other.startswith("term:"):
                        seen.add(other)
                        nxt.append(other)
            frontier = nxt
        return out

    def overlay_status(self, wid: str) -> dict:
        return {
            "overridden_by": list(self.overridden_by.get(wid, [])),
            "narrowed_by": list(self.narrowed_by.get(wid, [])),
        }

    def define(self, term: str) -> tuple[str, str] | None:
        return self.terms.get(" ".join(words(term)))

    def find_term(self, text: str) -> str | None:
        """Longest defined term that appears in text (allowing a trailing plural s)."""
        q = " " + " ".join(words(text)) + " "
        best = None
        for term in self.terms:
            if f" {term} " in q or f" {term}s " in q:
                if best is None or len(term) > len(best):
                    best = term
        return best

    def citation_lookup(self, query: str) -> tuple[str, str | None] | None:
        """Citation-shaped query -> direct id lookup (spec B.3 short-circuit)."""
        for src in self.sources.values():
            if not src.id_pattern or not src.id_template:
                continue
            m = src.id_pattern.search(query)
            if not m:
                continue
            gd = {k: (v or "") for k, v in m.groupdict().items()}
            wid = src.id_template.format(**gd)
            if wid not in self.works:
                continue
            anchor = None
            if src.anchor_template:
                a = re.sub(r"-+", "-", src.anchor_template.format(**gd)).strip("-")
                anchor = a or None
            return wid, anchor
        return None

    def table_rows(self, wid: str) -> list[str]:
        s = self.current.get(wid)
        if not s:
            return []
        return [r for t in s.tables for r in t.flat_rows()]

    def hub_boost(self, wid: str) -> float:
        return min(0.10, math.log1p(self.refs_in_count.get(wid, 0)) * 0.02)

    def stats(self) -> dict:
        return {
            "sources": len(self.sources),
            "works": len(self.works),
            "expressions": len(self.sections),
            "superseded": sum(1 for s in self.sections if s.superseded_by),
            "actions": len(self.actions),
            "terms": len(self.terms),
            "edges": len(self.edges),
            "tables": sum(len(s.tables) for s in self.sections),
        }
