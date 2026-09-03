"""Contract check for the spec B.2 corpus layout (the prototype's `sect index --validate-only`)."""

from __future__ import annotations

import datetime as dt

from .corpus import Corpus, Section, content_words, slug

REQUIRED = ["id", "source", "title", "parent", "order", "effective", "supersedes", "superseded_by", "amended_by",
            "overrides", "narrows", "defines", "context", "provenance"]
PROVENANCE = ["raw", "raw_sha256", "locator", "legal_status", "ingest_run", "confidence", "verified_by"]
LEGAL = {"official", "unofficial-xml", "derived"}


def _jaccard(a: str, b: str) -> float:
    sa, sb = set(content_words(a)), set(content_words(b))
    return len(sa & sb) / len(sa | sb) if sa | sb else 0.0


def validate(corpus: Corpus) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    def err(s: Section, msg: str) -> None:
        errors.append(f"{s.path.relative_to(corpus.root)}: {msg}")

    def warn(s: Section, msg: str) -> None:
        warnings.append(f"{s.path.relative_to(corpus.root)}: {msg}")

    seen_expr: set[str] = set()
    for s in corpus.sections:
        for k in REQUIRED:
            if k not in s.front:
                err(s, f"missing front matter key `{k}`")
        root_id = s.source.id_prefix.rstrip("-:/")
        if not s.id.startswith(s.source.id_prefix) and not (s.level == "title" and s.id == root_id):
            err(s, f"id `{s.id}` does not start with source prefix `{s.source.id_prefix}`")
        if s.expr in seen_expr:
            err(s, f"duplicate Expression `{s.expr}`")
        seen_expr.add(s.expr)
        if s.effective is None:
            err(s, "effective date missing or unparsable")
        if s.parent is not None and s.parent not in corpus.works:
            err(s, f"parent `{s.parent}` does not resolve")
        if s.parent is None and s.source.kind == "base" and s.level != "title":
            err(s, "base section without a parent")
        prov = s.front.get("provenance") or {}
        for k in PROVENANCE:
            if k not in prov:
                err(s, f"provenance missing `{k}`")
        if prov.get("legal_status") not in LEGAL:
            err(s, f"provenance.legal_status `{prov.get('legal_status')}` not in {sorted(LEGAL)}")
        if s.supersedes and s.supersedes not in corpus.by_expr:
            err(s, f"supersedes `{s.supersedes}` is not a known Expression")
        if s.superseded_by and s.superseded_by not in corpus.by_expr:
            err(s, f"superseded_by `{s.superseded_by}` is not a known Expression")
        if s.supersedes:
            prev = corpus.by_expr.get(s.supersedes)
            if prev and prev.superseded_by != s.expr:
                err(s, f"supersedes `{s.supersedes}` but that Expression's superseded_by is `{prev.superseded_by}`")
        for a in s.amended_by:
            act = corpus.actions_by_id.get(a)
            if not act:
                err(s, f"amended_by `{a}` is not a known Action")
            elif act.get("target_id") != s.id:
                err(s, f"Action `{a}` targets `{act.get('target_id')}`, not this section")
            elif act.get("text") and " ".join(str(act["text"]).split()) not in " ".join(s.body.split()):
                err(s, f"Action `{a}` quoted text is not present in this Expression")
        for t in s.overrides:
            tgt = corpus.current.get(t)
            if not tgt:
                err(s, f"overrides `{t}` does not resolve")
            elif tgt.source.kind != "base" or tgt.source.precedence >= s.source.precedence:
                err(s, f"overrides `{t}` must be base-kind and lower precedence")
        for n in s.narrows:
            tgt = corpus.current.get(n.get("id", ""))
            if not tgt:
                err(s, f"narrows `{n}` does not resolve")
            else:
                if tgt.source.kind != "base" or tgt.source.precedence >= s.source.precedence:
                    err(s, f"narrows `{n['id']}` must be base-kind and lower precedence")
                if n.get("anchor") and n["anchor"] not in tgt.anchors:
                    err(s, f"narrows anchor `{n['anchor']}` not found in `{n['id']}`")
        for t, a in s.links:
            tgt = corpus.current.get(t)
            if not tgt:
                err(s, f"link target `{t}` does not resolve")
                continue
            if a and a not in tgt.anchors:
                err(s, f"link anchor `{t}#{a}` not found (anchors: {', '.join(tgt.anchors)})")
            if s.effective and tgt.effective and corpus.as_of(t, s.effective) is None:
                err(s, f"link target `{t}` is not active at this section's effective date {s.effective}")
        body_low = s.body.lower()
        for term in s.defines:
            if term.lower() not in body_low:
                err(s, f"defined term `{term}` does not appear in the body")
        n_ctx = len(s.context.split())
        if s.level in ("section", "notice", "note") and not (40 <= n_ctx <= 110):
            warn(s, f"context prefix is {n_ctx} words; spec asks for roughly 50-100 tokens")
        sim = _jaccard(s.context, s.body)
        if sim >= 0.8:
            err(s, f"context prefix paraphrases the body (similarity {sim:.2f} >= 0.8)")
        if s.kind == "notice" and not s.actions:
            err(s, "notice without Action records")
        for act in s.actions:
            for k in ("action_id", "target_id", "kind", "effective", "text"):
                if k not in act:
                    err(s, f"Action missing `{k}`")
            if act.get("target_id") not in corpus.works:
                err(s, f"Action target `{act.get('target_id')}` does not resolve")
    return errors, warnings
