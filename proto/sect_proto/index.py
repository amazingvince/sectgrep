"""Ranking prototype for spec B.4: field-weighted BM25 + model2vec cosine -> RRF -> signals.

Built on semble's pieces (BM25 index, model loading and chunk embedding, tokenizer) with the
spec's own chunk text (breadcrumb + context prefix + body), field boosts, and rerank signals.
A plain semble hybrid over the same chunks is kept as a comparison arm.
"""

from __future__ import annotations

import os
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

_PROTO_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(_PROTO_DIR / ".hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import numpy as np  # noqa: E402
from semble import search as semble_search  # noqa: E402
from semble.index.bm25 import BM25  # noqa: E402
from semble.index.dense import SelectableBasicBackend, embed_chunks, load_model  # noqa: E402
from semble.tokens import tokenize  # noqa: E402
from semble.types import Chunk  # noqa: E402
from vicinity.backends.basic import BasicArgs  # noqa: E402

import Stemmer  # noqa: E402

from .corpus import STOPWORDS, Corpus, Section, content_words, words  # noqa: E402

MODEL = os.environ.get("SECT_PROTO_MODEL", "minishlab/potion-retrieval-32M")
STEM = os.environ.get("SECT_PROTO_STEM", "1") != "0"
_STEMMER = Stemmer.Stemmer("english")


def text_tokens(text: str) -> list[str]:
    """BM25 tokens for text fields: semble's tokenizer, minus stopwords, Porter-stemmed.

    Stopwords must go: in a short field such as a title, `a` (as in "Subchapter A") or `part`
    is rare and gets a large IDF, so a natural-language query full of function words ranks
    structural nodes above the section it is about.
    """
    toks = [t for t in tokenize(text) if t not in STOPWORDS]
    return _STEMMER.stemWords(toks) if STEM else toks
RRF_K = 60
CANDIDATES = 100
MAX_CHUNK_TOKENS = 2000
FIELD_WEIGHTS = {"title": 3.0, "path": 2.0, "context": 1.5, "body": 1.0, "citations": 3.0, "terms_defined": 4.0}
DEF_CUE = r"(?:defin\w*\s+of|definition\s+of|meaning\s+of|what\s+is|what\s+are|what\s+does|who\s+is|what\s+counts\s+as|define|term)"
CITE_RES = [
    re.compile(r"\b([1-3]\.\d{1,2})\b"),
    re.compile(r"\b(am-\d{1,3})\b"),
    re.compile(r"\b(20\d{2}-\d{5})\b"),
    re.compile(r"\b(cfr:99-[0-9a-z.\-]+)"),
]


def cite_tokens(text: str) -> list[str]:
    t = text.lower()
    out: list[str] = []
    for r in CITE_RES:
        out.extend(r.findall(t))
    return out


def id_variants(wid: str) -> list[str]:
    low = wid.lower()
    out = [low]
    tail = low.split(":", 1)[-1]
    out.append(tail)
    if "-" in tail:
        out.append(tail.split("-")[-1])
    return out


@dataclass
class ChunkRec:
    idx: int
    section: Section
    text: str
    fields: dict[str, str]
    part: int = 0
    nparts: int = 1


@dataclass
class Hit:
    section: Section
    score: float
    anchor: str | None = None
    reason: str = ""
    expanded: list[dict] = field(default_factory=list)


@dataclass
class Result:
    query: str
    hits: list[Hit]
    abstained: bool
    nearest: str | None
    latency_ms: float
    candidates: int
    lex_conf: float
    sem_conf: float
    lines: list[str] = field(default_factory=list)


def _split_body(body: str) -> list[str]:
    """Split an oversize section at top-level paragraph labels only (spec B.2)."""
    if len(body.split()) <= MAX_CHUNK_TOKENS:
        return [body]
    parts: list[str] = []
    cur: list[str] = []
    for para in body.split("\n\n"):
        if re.match(r"^\([a-z]\)\s", para.strip()) and cur and len(" ".join(cur).split()) > MAX_CHUNK_TOKENS // 2:
            parts.append("\n\n".join(cur))
            cur = []
        cur.append(para)
    if cur:
        parts.append("\n\n".join(cur))
    return parts


class Searcher:
    def __init__(self, corpus: Corpus, contextual: bool = True, model_name: str = MODEL):
        self.corpus = corpus
        self.contextual = contextual
        self.model, self.model_name = load_model(model_name)
        self.chunks: list[ChunkRec] = []
        for s in corpus.sections:
            body = s.body_plain
            table_rows = [r for t in s.tables for r in t.flat_rows()]
            pieces = _split_body(body)
            for i, piece in enumerate(pieces):
                extra = ("\n" + "\n".join(table_rows)) if table_rows and i == len(pieces) - 1 else ""
                if contextual:
                    text = f"{s.breadcrumb}\n{s.context}\n{piece}{extra}"
                else:
                    text = f"{piece}{extra}"
                cites = " ".join(v for t in [s.id] + s.link_targets for v in id_variants(t))
                fields = {
                    "title": f"{s.label} {s.title}",
                    "path": s.breadcrumb if contextual else "",
                    "context": s.context if contextual else "",
                    "body": piece + extra,
                    "citations": cites,
                    "terms_defined": " ".join(s.defines),
                }
                self.chunks.append(ChunkRec(len(self.chunks), s, text, fields, i, len(pieces)))
        self.semble_chunks = [Chunk(content=c.text, file_path=str(c.section.path), start_line=c.idx, end_line=c.idx) for c in self.chunks]
        self.chunk_index = {sc: i for i, sc in enumerate(self.semble_chunks)}
        ids = [str(c.idx) for c in self.chunks]
        self.bm25: dict[str, BM25] = {}
        for f in FIELD_WEIGHTS:
            b = BM25()
            for c in self.chunks:
                toks = cite_tokens(c.fields[f]) if f == "citations" else text_tokens(c.fields[f])
                b.add_document(str(c.idx), toks)
            b.set_doc_order(ids)
            self.bm25[f] = b
        self.bm25_all = BM25()
        for c, sc in zip(self.chunks, self.semble_chunks):
            self.bm25_all.add_document(str(c.idx), tokenize(sc.content))
        self.bm25_all.set_doc_order(ids)
        self.emb = embed_chunks(self.model, self.semble_chunks)
        norms = np.linalg.norm(self.emb, axis=1, keepdims=True) + 1e-9
        self.emb_n = self.emb / norms
        self.backend = SelectableBasicBackend(self.emb, BasicArgs())
        self.chunk_words = [set(words(c.text)) for c in self.chunks]
        self.title_words = [set(content_words(c.fields["title"] + " " + c.fields["path"])) for c in self.chunks]
        self.n = len(self.chunks)

    # ---- helpers ------------------------------------------------------------------------
    def _mask(self, as_of, include_superseded, kind, source) -> np.ndarray:
        m = np.zeros(self.n, dtype=bool)
        for c in self.chunks:
            s = c.section
            ok = self.corpus.active(s, as_of, include_superseded)
            if kind and s.kind != kind:
                ok = False
            if source and s.source.name != source:
                ok = False
            m[c.idx] = ok
        return m

    def _encode(self, query: str) -> np.ndarray:
        v = np.asarray(self.model.encode([query]), dtype=np.float32)[0]
        return v / (np.linalg.norm(v) + 1e-9)

    def bm25_scores(self, query: str, fielded: bool = True) -> np.ndarray:
        if not fielded:
            return np.asarray(self.bm25_all.get_scores(tokenize(query)), dtype=np.float32)
        total = np.zeros(self.n, dtype=np.float32)
        qt = text_tokens(query)
        qc = cite_tokens(query)
        for f, w in FIELD_WEIGHTS.items():
            toks = qc if f == "citations" else qt
            if toks:
                total += w * np.asarray(self.bm25[f].get_scores(toks), dtype=np.float32)
        return total

    def cosine(self, query: str) -> np.ndarray:
        return self.emb_n @ self._encode(query)

    @staticmethod
    def _top(scores: np.ndarray, mask: np.ndarray, k: int, positive_only: bool) -> list[int]:
        s = np.where(mask, scores, -np.inf)
        order = np.argsort(-s)
        out = []
        for i in order[:k]:
            if not np.isfinite(s[i]) or (positive_only and s[i] <= 0):
                break
            out.append(int(i))
        return out

    def _define_shaped(self, query: str) -> tuple[str, str, str] | None:
        q = " ".join(words(query))
        for term in sorted(self.corpus.terms, key=len, reverse=True):
            pat = rf"(?:{DEF_CUE})\s+(?:a\s+|an\s+|the\s+)?{re.escape(term)}s?\b|\b{re.escape(term)}s?\s+(?:definition|meaning|means|defined|vs|versus)\b"
            if re.search(pat, q):
                wid, anchor = self.corpus.terms[term]
                return term, wid, anchor
        return None

    # ---- baselines ----------------------------------------------------------------------
    def rank_ids(self, scores: np.ndarray, mask: np.ndarray, k: int = 50, positive_only: bool = True) -> list[str]:
        out: list[str] = []
        for i in self._top(scores, mask, k, positive_only):
            wid = self.chunks[i].section.id
            if wid not in out:
                out.append(wid)
        return out

    def baseline(self, query: str, arm: str, k: int = 50) -> list[str]:
        """Non-contextual baselines for the CRAwLeR adversarial filter, and the semble arm."""
        mask = self._mask(None, False, None, None)
        if arm == "bm25":
            return self.rank_ids(self.bm25_scores(query, fielded=False), mask, k)
        if arm == "vector":
            return self.rank_ids(self.cosine(query), mask, k, positive_only=False)
        if arm == "semble":
            selector = np.flatnonzero(mask)
            res = semble_search.search(query, self.model, self.backend, self.bm25_all, self.semble_chunks, k, alpha=None, selector=selector, rerank=False)
            out: list[str] = []
            for r in res:
                wid = self.chunks[self.chunk_index[r.chunk]].section.id
                if wid not in out:
                    out.append(wid)
            return out
        raise ValueError(arm)

    # ---- the spec pipeline --------------------------------------------------------------
    def search(
        self,
        query: str,
        limit: int = 10,
        as_of=None,
        include_superseded: bool = False,
        kind: str | None = None,
        source: str | None = None,
        expand: str | None = None,
        fts: bool = True,
        vector: bool = True,
        floor_lex: float = 0.34,
        floor_sem: float = 0.30,
        floor_hard: float = 0.22,
    ) -> Result:
        t0 = time.perf_counter()
        limit = min(limit, 50)
        mask = self._mask(as_of, include_superseded, kind, source)
        pinned: list[tuple[str, str | None, str]] = []
        cit = self.corpus.citation_lookup(query)
        if cit:
            wid, anchor = cit
            sec = self.corpus.as_of(wid, as_of) if as_of else self.corpus.current.get(wid)
            if sec and self.corpus.active(sec, as_of, include_superseded):
                pinned.append((sec.expr, anchor, "citation short-circuit"))
        dq = self._define_shaped(query)
        if dq:
            term, wid, anchor = dq
            sec = self.corpus.as_of(wid, as_of) if as_of else self.corpus.current.get(wid)
            if sec and self.corpus.active(sec, as_of, include_superseded):
                pinned.append((sec.expr, anchor, f"definition resolution: {term}"))

        qcites = cite_tokens(query)
        qcw = set(content_words(query))
        bm = self.bm25_scores(query) if fts else np.zeros(self.n, dtype=np.float32)
        cos = self.cosine(query) if vector else np.full(self.n, -1.0, dtype=np.float32)
        # ID/term-like (spec B.4): a citation, a citation token, or a defined term that makes up
        # most of the query. A long question that merely mentions "employer" is not term-like.
        term = self.corpus.find_term(query)
        term_like = term is not None and (len(qcw) <= 3 or 2 * len(term.split()) >= len(qcw))
        idlike = bool(cit) or bool(qcites) or term_like
        w_b = 2.0 if idlike else 1.0
        w_v = 1.0
        bm_top = self._top(bm, mask, CANDIDATES, True) if fts else []
        vec_top = self._top(cos, mask, CANDIDATES, False) if vector else []
        fused: dict[int, float] = {}
        for r, i in enumerate(bm_top, 1):
            fused[i] = fused.get(i, 0.0) + w_b / (RRF_K + r)
        for r, i in enumerate(vec_top, 1):
            fused[i] = fused.get(i, 0.0) + w_v / (RRF_K + r)
        norm = (w_b + w_v) / (RRF_K + 1)
        scores = {i: s / norm for i, s in fused.items()}
        for i in list(scores):
            sec = self.chunks[i].section
            if qcw:
                scores[i] += 0.10 * len(qcw & self.title_words[i]) / len(qcw)
            scores[i] += self.corpus.hub_boost(sec.id)
            if sec.kind == "note":
                scores[i] -= 0.20
            if include_superseded and sec.superseded_by:
                scores[i] -= 0.50
        counts = Counter(self.chunks[i].section.expr for i in scores)
        best: dict[str, tuple[int, float]] = {}
        for i, s in scores.items():
            key = self.chunks[i].section.expr
            if counts[key] >= 3:
                s += 0.10
            if key not in best or s > best[key][1]:
                best[key] = (i, s)
        ranked = sorted(best.items(), key=lambda kv: -kv[1][1])
        hits: list[Hit] = []
        for expr, (i, s) in ranked:
            hits.append(Hit(self.chunks[i].section, round(s, 4)))
        for expr, anchor, reason in reversed(pinned):
            hits = [h for h in hits if h.section.expr != expr]
            hits.insert(0, Hit(self.corpus.by_expr[expr], 2.0, anchor, reason))
        candidates = len(best)
        top_hits = hits[:limit]

        lex_conf = sem_conf = 0.0
        abstained = False
        nearest = None
        if top_hits:
            top = top_hits[0]
            idx = next((c.idx for c in self.chunks if c.section.expr == top.section.expr), None)
            if idx is not None:
                lex_conf = (len(qcw & self.chunk_words[idx]) / len(qcw)) if qcw else 0.0
                sem_conf = float(cos[idx]) if vector else 0.0
            weak = lex_conf < floor_lex and sem_conf < floor_sem
            if not pinned and (weak or (vector and sem_conf < floor_hard)):
                abstained = True
                nearest = top.section.breadcrumb
        else:
            abstained = True
        if expand == "refs":
            for h in top_hits:
                for e in self.corpus.refs(h.section.id, "out", "references", 1):
                    t = self.corpus.section(e["to"])
                    if t:
                        h.expanded.append({"id": t.id, "anchor": e["anchor"], "title": t.title})
        elif expand == "ancestors":
            for h in top_hits:
                h.expanded = [{"id": a.id, "title": a.title} for a in self.corpus.ancestors(h.section.id)]
        ms = (time.perf_counter() - t0) * 1000
        lines = [
            f"freshness: fresh (fixture, {self.n} chunks indexed)",
            f"counts: {len(top_hits)} shown of {candidates} candidates; lexical weight x{w_b:g}; "
            + ("ABSTAIN: nothing above the confidence floor" if abstained else "confident"),
        ]
        return Result(query, top_hits if not abstained else top_hits, abstained, nearest, ms, candidates, lex_conf, sem_conf, lines)
