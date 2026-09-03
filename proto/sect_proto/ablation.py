"""Milestone-0 ablation: what the static embedder and the BM25 tokenizer should see.

Varies the chunk text (body / context+body / title+context+body / breadcrumb+context+body),
mean-centering of the static embeddings, and stemming of BM25 tokens, and reports Recall@5 on
locate, definition, and all cross-ref questions for each leg and for an equal-weight RRF hybrid.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import Stemmer
from semble.index.bm25 import BM25
from semble.index.dense import load_model
from semble.tokens import tokenize

from .corpus import STOPWORDS, Corpus
from .evaluate import load_questions, recall_at_k
from .index import MODEL, RRF_K

VARIANTS = ["body", "context+body", "title+context+body", "breadcrumb+context+body"]


def chunk_text(s, variant: str) -> str:
    tables = "\n".join(r for t in s.tables for r in t.flat_rows())
    body = s.body_plain + ("\n" + tables if tables else "")
    if variant == "body":
        return body
    if variant == "context+body":
        return f"{s.context}\n{body}"
    if variant == "title+context+body":
        return f"{s.label} {s.title}\n{s.context}\n{body}"
    return f"{s.breadcrumb}\n{s.context}\n{body}"


def run(corpus: Corpus, qdir: Path, out: Path) -> None:
    model, _ = load_model(MODEL)
    stemmer = Stemmer.Stemmer("english")
    secs = [s for s in corpus.sections if not s.superseded_by]
    ids = [s.id for s in secs]
    qs = [q for q in load_questions(qdir) if q["type"] in ("locate", "definition", "cross-ref") and q.get("gold")]
    types = ["locate", "definition", "cross-ref"]

    def recall(rank_fn) -> dict[str, float]:
        per: dict[str, list[float]] = {}
        for q in qs:
            per.setdefault(q["type"], []).append(recall_at_k(q["gold"], rank_fn(q["query"]), 5))
        return {t: sum(v) / len(v) for t, v in per.items()}

    rows: list[tuple[str, dict[str, float]]] = []
    for variant in VARIANTS:
        texts = [chunk_text(s, variant) for s in secs]
        E = np.asarray(model.encode(texts), dtype=np.float32)
        mu = E.mean(0)
        vec_rankers = {}
        for center in (False, True):
            Ec = E - mu if center else E
            En = Ec / (np.linalg.norm(Ec, axis=1, keepdims=True) + 1e-9)

            def scores_vec(q, En=En, center=center):
                v = np.asarray(model.encode([q]), dtype=np.float32)[0]
                if center:
                    v = v - mu
                v = v / (np.linalg.norm(v) + 1e-9)
                return En @ v

            vec_rankers[center] = scores_vec
            rows.append((f"vector | {variant} | {'mean-centered' if center else 'raw'}", recall(lambda q, f=scores_vec: [ids[i] for i in np.argsort(-f(q))[:10]])))
        bm_rankers = {}
        treatments = {"raw": (False, False), "stemmed": (True, False), "stemmed, stopwords removed": (True, True)}
        for name, (stem, stop) in treatments.items():
            def toks_of(text, stem=stem, stop=stop):
                toks = [t for t in tokenize(text) if not (stop and t in STOPWORDS)]
                return stemmer.stemWords(toks) if stem else toks

            b = BM25()
            for i, t in enumerate(texts):
                b.add_document(str(i), toks_of(t))
            b.set_doc_order([str(i) for i in range(len(texts))])

            def scores_bm(q, b=b, toks_of=toks_of):
                return np.asarray(b.get_scores(toks_of(q)), dtype=np.float32)

            bm_rankers[name] = scores_bm
            rows.append((f"bm25 | {variant} | {name}", recall(lambda q, f=scores_bm: [ids[i] for i in np.argsort(-f(q))[:10] if f(q)[i] > 0])))
        for stem, center in (("raw", False), ("stemmed, stopwords removed", False), ("stemmed, stopwords removed", True)):
            fb, fv = bm_rankers[stem], vec_rankers[center]

            def rank_hybrid(q, fb=fb, fv=fv):
                sb, sv = fb(q), fv(q)
                fused = np.zeros(len(ids))
                for r, i in enumerate(np.argsort(-sb)[:100], 1):
                    if sb[i] > 0:
                        fused[i] += 1 / (RRF_K + r)
                for r, i in enumerate(np.argsort(-sv)[:100], 1):
                    fused[i] += 1 / (RRF_K + r)
                return [ids[i] for i in np.argsort(-fused)[:10]]

            rows.append((f"hybrid RRF | {variant} | bm25 {stem} + vector {'mean-centered' if center else 'raw'}", recall(rank_hybrid)))

    L = ["# Milestone 0 ablation: chunk text, stemming, and mean-centering\n",
         f"Generated {dt.datetime.now().isoformat(timespec='seconds')}. Recall@5 on the fixture question set, current Expressions only; "
         f"cross-ref counts all {sum(1 for q in qs if q['type'] == 'cross-ref')} author-written questions before the adversarial filter. Model `{MODEL}` (static, mean-of-token embeddings).\n",
         "| Leg | Chunk text | Treatment | locate | definition | cross-ref |", "|---|---|---|---|---|---|"]
    for name, r in rows:
        leg, variant, treat = [p.strip() for p in name.split("|")]
        L.append(f"| {leg} | {variant} | {treat} | " + " | ".join(f"{r.get(t, 0):.2f}" for t in types) + " |")
    L.append("\nReading: a static embedder averages token vectors, so a prefix shared by every chunk (the breadcrumb) moves every vector toward one common direction and cosine stops discriminating; "
             "subtracting the corpus mean removes that direction. BM25 without stemming misses `exits` vs `exit`, `firefighters` vs `firefighting`, `hazard` vs `hazardous`.\n")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print("\n".join(L))
