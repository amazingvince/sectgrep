//! Evidence assembly quotes pinned source ranges; retrieval prefixes are never evidence.
use sect_index::{chunks::SourceSpan, query_chunks::QueryChunk, search_state::SearchState, Index};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct EvidenceExcerpt {
    pub expr: String,
    pub title: String,
    pub text: String,
    pub spans: Vec<SourceSpan>,
    /// Locators cover the canonical unit. `spans` narrow this to the quoted body bytes.
    pub unit_provenance: Option<sect_core::Provenance>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Continuation {
    pub expr: String,
    pub chunk_id: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct EvidencePacket {
    pub version: u32,
    pub primary: EvidenceExcerpt,
    pub context: Vec<EvidenceExcerpt>,
    pub context_basis: String,
    pub passage_complete: bool,
    pub section_complete: bool,
    pub continuation: Vec<Continuation>,
    pub words: usize,
    pub budget_unit: String,
}

/// Return a complete matching paragraph when possible, with a bounded, explicitly incomplete
/// fallback for old generations or an unusually large paragraph. All offsets remain exact.
pub(super) fn select(body: &str, terms: &[String], budget: usize) -> (usize, usize) {
    if body.split_whitespace().count() <= budget {
        return (0, body.len());
    }
    if budget == 0 {
        return (0, 0);
    }
    let mut offset = 0;
    let mut best = (0, 0, 0);
    for paragraph in body.split("\n\n") {
        let low = paragraph.to_lowercase();
        let score = terms.iter().filter(|t| low.contains(t.as_str())).count();
        if !paragraph.trim_start().starts_with('#') && (score > best.0 || best.2 == 0) {
            best = (score, offset, offset + paragraph.len());
        }
        offset += paragraph.len() + 2;
    }
    if best.2 == 0 {
        // Explicit navigation lookup can contain headings only. It still needs a
        // bounded quotation when the caller supplies a very small budget.
        best = (0, 0, body.len());
    }
    let start = best.1;
    let paragraph = &body[start..best.2];
    if paragraph.split_whitespace().count() <= budget {
        return (start, best.2);
    }
    // Prefer the sentence containing the needle before falling back to a word window.
    let mut sentence_start = 0;
    for (i, c) in paragraph.char_indices() {
        if matches!(c, '.' | '!' | '?')
            && paragraph[i + c.len_utf8()..].starts_with(char::is_whitespace)
        {
            let text = &paragraph[sentence_start..i + c.len_utf8()];
            if text.split_whitespace().count() <= budget
                && terms.iter().any(|t| text.to_lowercase().contains(t))
            {
                return (start + sentence_start, start + i + c.len_utf8());
            }
            sentence_start = i + c.len_utf8();
        }
    }
    let mut word_ranges = Vec::new();
    let mut beginning = None;
    for (i, c) in paragraph.char_indices().chain([(paragraph.len(), ' ')]) {
        if c.is_whitespace() {
            if let Some(begin) = beginning.take() {
                word_ranges.push((begin, i));
            }
        } else if beginning.is_none() {
            beginning = Some(i);
        }
    }
    let needle = word_ranges
        .iter()
        .position(|(a, b)| {
            terms
                .iter()
                .any(|t| paragraph[*a..*b].to_lowercase().contains(t))
        })
        .unwrap_or(0);
    let lo = needle
        .saturating_sub(budget / 3)
        .min(word_ranges.len().saturating_sub(budget));
    let hi = (lo + budget).min(word_ranges.len());
    (start + word_ranges[lo].0, start + word_ranges[hi - 1].1)
}

fn excerpt(
    index: &Index,
    c: &QueryChunk,
    span: Option<&SourceSpan>,
    start: usize,
    end: usize,
) -> EvidenceExcerpt {
    let base = span.map(|s| s.passage_start).unwrap_or(0);
    let expr = span.map(|s| s.expr.as_str()).unwrap_or(&c.expr);
    let body = &c.body[base..span.map(|s| s.passage_end).unwrap_or(c.body.len())];
    let text = body[start..end].to_string();
    let spans = span
        .into_iter()
        .map(|s| SourceSpan {
            expr: s.expr.clone(),
            title: s.title.clone(),
            breadcrumb: s.breadcrumb.clone(),
            body_sha256: s.body_sha256.clone(),
            passage_start: s.passage_start + start,
            passage_end: s.passage_start + end,
            byte_start: s.byte_start + start,
            byte_end: s.byte_start + end,
            line_start: s.line_start + body[..start].bytes().filter(|b| *b == b'\n').count(),
            line_end: s.line_start + body[..end].bytes().filter(|b| *b == b'\n').count(),
        })
        .collect();
    let provenance = index
        .tree
        .get(sect_core::split_expr(expr).0)
        .and_then(|n| n.expressions.iter().find(|e| e.expr == expr))
        .and_then(|e| e.front.provenance.clone());
    EvidenceExcerpt {
        expr: expr.into(),
        title: span
            .map(|s| s.title.clone())
            .unwrap_or_else(|| c.title.clone()),
        text,
        spans,
        unit_provenance: provenance,
    }
}

pub(super) fn assemble(
    index: &Index,
    state: &SearchState,
    hits: &mut [super::SearchHit],
    allowed: &HashSet<String>,
    terms: &[String],
    opts: &super::SearchOptions,
) {
    let mut remaining = opts.evidence_budget.min(20_000);
    for hit in hits.iter_mut() {
        let c = &state.chunks[state.by_chunk[&hit.chunk_id]];
        let span = c.spans.iter().find(|s| s.expr == hit.expr);
        let body = span
            .map(|s| &c.body[s.passage_start..s.passage_end])
            .unwrap_or(&c.body);
        let (start, end) = select(body, terms, remaining);
        let primary = excerpt(index, c, span, start, end);
        let words = primary.text.split_whitespace().count();
        remaining -= words;
        let complete = start == 0 && end == body.len();
        let mut continuation = Vec::new();
        if !complete {
            continuation.push(Continuation {
                expr: hit.expr.clone(),
                chunk_id: c.chunk_id.clone(),
                reason: "evidence budget".into(),
            });
        }
        if c.nparts > 1 {
            continuation.push(Continuation {
                expr: hit.expr.clone(),
                chunk_id: c.chunk_id.clone(),
                reason: format!(
                    "passage {} of {}; read the expression for the complete section",
                    c.part + 1,
                    c.nparts
                ),
            });
        }
        if !opts.legacy_snippets {
            hit.snippet = primary.text.clone();
            hit.line = primary.spans.first().map(|s| s.line_start).or(hit.line);
        }
        hit.evidence=Some(EvidencePacket { version:1,primary,context:Vec::new(),context_basis:"same-parent source units and structural ancestry; semantic completeness is not asserted".into(),passage_complete:complete,section_complete:complete && c.nparts==1,continuation,words,budget_unit:"whitespace_words".into() });
    }
    // Parent lead-ins are often where the scope/condition lives. Explicit filters and revision
    // selection still apply; never follow a current parent while answering an historical query.
    let mut included: HashSet<String> = hits.iter().map(|h| h.expr.clone()).collect();
    let mut supports = HashSet::new();
    for hit in hits.iter_mut() {
        let packet = hit.evidence.as_mut().expect("assembled primary");
        let c = &state.chunks[state.by_chunk[&hit.chunk_id]];
        for support in &c.support {
            let span = &support.span;
            if !allowed.contains(&span.expr)
                || !supports.insert((span.expr.clone(), span.byte_start, span.byte_end))
            {
                continue;
            }
            if packet.primary.spans.iter().any(|s| {
                s.expr == span.expr
                    && s.byte_start <= span.byte_start
                    && s.byte_end >= span.byte_end
            }) {
                continue;
            }
            let words = support.text.split_whitespace().count();
            if words > remaining {
                packet.continuation.push(Continuation {
                    expr: span.expr.clone(),
                    chunk_id: c.chunk_id.clone(),
                    reason: format!("required {} exceeds evidence budget", support.role),
                });
                continue;
            }
            let provenance = index
                .tree
                .get(sect_core::split_expr(&span.expr).0)
                .and_then(|n| n.expressions.iter().find(|e| e.expr == span.expr))
                .and_then(|e| e.front.provenance.clone());
            packet.context.push(EvidenceExcerpt {
                expr: span.expr.clone(),
                title: format!("{} ({})", span.title, support.role),
                text: support.text.clone(),
                spans: vec![span.clone()],
                unit_provenance: provenance,
            });
            packet.words += words;
            remaining -= words;
        }
    }
    for hit in hits.iter_mut() {
        let packet = hit.evidence.as_mut().expect("assembled primary");
        let passage = &state.chunks[state.by_chunk[&hit.chunk_id]];
        for span in &passage.spans {
            if !allowed.contains(&span.expr) || included.contains(&span.expr) {
                continue;
            }
            let words = passage.body[span.passage_start..span.passage_end]
                .split_whitespace()
                .count();
            if words > remaining {
                packet.continuation.push(Continuation {
                    expr: span.expr.clone(),
                    chunk_id: passage.chunk_id.clone(),
                    reason: "peer context exceeds remaining budget".into(),
                });
                continue;
            }
            included.insert(span.expr.clone());
            packet.context.push(excerpt(
                index,
                passage,
                Some(span),
                0,
                span.passage_end - span.passage_start,
            ));
            packet.words += words;
            remaining -= words;
        }
        let Some(node) = index.tree.get(&hit.id) else {
            continue;
        };
        let Some(revision) = node.expressions.iter().find(|e| e.expr == hit.expr) else {
            continue;
        };
        let date = opts
            .as_of
            .or({
                if opts.include_superseded {
                    hit.effective
                } else {
                    None
                }
            })
            .unwrap_or_else(|| chrono::Utc::now().date_naive());
        let mut parent = revision.front.parent.clone();
        let mut seen = HashSet::new();
        while let Some(id) = parent.take() {
            if !seen.insert(id.clone()) || seen.len() > 2 {
                break;
            }
            let Some(e) = index
                .tree
                .as_of(&id, date)
                .filter(|e| allowed.contains(&e.expr))
            else {
                break;
            };
            parent = e.front.parent.clone();
            // These are source headings within the enclosing section, not inferred graph
            // edges. A namesake definition elsewhere in the document is never pulled in.
            for context_expr in state.context_by_parent.get(&id).into_iter().flatten() {
                if !allowed.contains(context_expr) || included.contains(context_expr) {
                    continue;
                }
                if index
                    .tree
                    .as_of(sect_core::split_expr(context_expr).0, date)
                    .is_none_or(|e| &e.expr != context_expr)
                {
                    continue;
                }
                let Some(&i) = state.first_chunk_by_expr.get(context_expr) else {
                    continue;
                };
                let context = &state.chunks[i];
                let Some(span) = context.spans.iter().find(|s| &s.expr == context_expr) else {
                    continue;
                };
                let body = &context.body[span.passage_start..span.passage_end];
                let words = body.split_whitespace().count();
                if words > remaining {
                    packet.continuation.push(Continuation {
                        expr: context_expr.clone(),
                        chunk_id: context.chunk_id.clone(),
                        reason: "enclosing definition/scope exceeds evidence budget".into(),
                    });
                    continue;
                }
                included.insert(context_expr.clone());
                packet
                    .context
                    .push(excerpt(index, context, Some(span), 0, body.len()));
                packet.words += words;
                remaining -= words;
            }
            let Some(&i) = state.first_chunk_by_expr.get(&e.expr) else {
                continue;
            };
            let c = &state.chunks[i];
            if c.navigation || !included.insert(c.expr.clone()) {
                continue;
            }
            let span = c.spans.iter().find(|s| s.expr == e.expr);
            let body = span
                .map(|s| &c.body[s.passage_start..s.passage_end])
                .unwrap_or(&c.body);
            let words = body.split_whitespace().count();
            if words > remaining {
                packet.continuation.push(Continuation {
                    expr: c.expr.clone(),
                    chunk_id: c.chunk_id.clone(),
                    reason: "parent context exceeds remaining budget".into(),
                });
                continue;
            }
            packet.context.push(excerpt(index, c, span, 0, body.len()));
            packet.words += words;
            remaining -= words;
            if c.nparts > 1 {
                packet.continuation.push(Continuation {
                    expr: c.expr.clone(),
                    chunk_id: c.chunk_id.clone(),
                    reason: "parent section has further passages".into(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_paragraphs_preserve_operative_conditions() {
        let body="Heading\n\nIf annual income declines more than 20 percent, the lender must downgrade and manually underwrite the file.\n\nUnrelated other details.";
        let (a, b) = select(body, &["declines".into()], 19);
        assert_eq!(&body[a..b],"If annual income declines more than 20 percent, the lender must downgrade and manually underwrite the file.");
        let (a, b) = select(body, &["declines".into()], 0);
        assert_eq!(a, b);
    }

    #[test]
    fn heading_only_lookup_obeys_small_budget() {
        let body = "# A long navigation heading";
        let (a, b) = select(body, &["navigation".into()], 1);
        assert_eq!(&body[a..b], "navigation");
        assert_eq!(select("", &[], 1), (0, 0));
    }
}
