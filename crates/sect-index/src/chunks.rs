//! Chunking (spec B.4): one chunk per section file; files over ~2,000 tokens are split only at
//! top-level paragraph labels, never mid-provision. Chunk text = breadcrumb + `context` prefix +
//! body (+ flattened table rows). Both the lexical and the semantic layers index these chunks.

use std::path::Path;

use chrono::NaiveDate;
use sect_core::{Result, SectError};
use sect_corpus::{Document, Via};
use sect_struct::Tree;
use serde::{Deserialize, Serialize};

pub const MAX_TOKENS: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    /// `<expr>#c<part>`
    pub chunk_id: String,
    pub expr: String,
    pub id: String,
    pub part: usize,
    pub nparts: usize,
    pub node: Option<String>,
    pub label: String,
    pub title: String,
    pub breadcrumb: String,
    pub context: String,
    /// This part's body (links stripped to their text, table rows appended as sentences).
    pub body: String,
    /// What gets embedded and indexed: breadcrumb + context + body.
    pub text: String,
    /// 1-based body line range covered by this part.
    pub line_start: usize,
    pub line_end: usize,
    pub source: String,
    pub kind: String,
    pub effective: Option<NaiveDate>,
    pub superseded: bool,
    pub citations: Vec<String>,
    pub terms_defined: Vec<String>,
}

fn tokens(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Split a body into parts at top-level paragraph labels when it exceeds `MAX_TOKENS`.
/// Returns (text, line_start, line_end) triples.
fn split_body(body: &str) -> Vec<(String, usize, usize)> {
    if tokens(body) <= MAX_TOKENS {
        return vec![(body.to_string(), 1, body.lines().count().max(1))];
    }
    // Paragraphs with their 1-based starting line.
    let mut paras: Vec<(usize, String)> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut start = 1;
    for (i, line) in body.lines().enumerate() {
        if line.trim().is_empty() {
            if !cur.is_empty() {
                paras.push((start, cur.join("\n")));
                cur.clear();
            }
        } else {
            if cur.is_empty() {
                start = i + 1;
            }
            cur.push(line);
        }
    }
    if !cur.is_empty() {
        paras.push((start, cur.join("\n")));
    }
    let is_label = |p: &str| {
        let t = p.trim_start();
        t.starts_with('(') && t.chars().nth(1).map(|c| c.is_ascii_lowercase()).unwrap_or(false) && t.chars().nth(2) == Some(')')
    };
    let mut out: Vec<(String, usize, usize)> = Vec::new();
    let mut acc: Vec<&(usize, String)> = Vec::new();
    let mut acc_tokens = 0;
    let flush = |acc: &mut Vec<&(usize, String)>, out: &mut Vec<(String, usize, usize)>| {
        if acc.is_empty() {
            return;
        }
        let text = acc.iter().map(|(_, p)| p.as_str()).collect::<Vec<_>>().join("\n\n");
        let first = acc[0].0;
        let last = acc.last().unwrap();
        let end = last.0 + last.1.lines().count().saturating_sub(1);
        out.push((text, first, end));
        acc.clear();
    };
    for p in &paras {
        let n = tokens(&p.1);
        if acc_tokens + n > MAX_TOKENS && is_label(&p.1) && !acc.is_empty() {
            flush(&mut acc, &mut out);
            acc_tokens = 0;
        }
        acc.push(p);
        acc_tokens += n;
    }
    flush(&mut acc, &mut out);
    out
}

pub fn build_chunks(docs: &[Document], tree: &Tree) -> Vec<Chunk> {
    let mut out = Vec::new();
    for d in docs {
        let (Some(id), Some(expr)) = (d.id().map(str::to_string), d.expr()) else { continue };
        let Some(node) = tree.get(&id) else { continue };
        let tables: Vec<String> = d.tables.iter().flat_map(|t| t.flat_rows()).collect();
        let parts = split_body(&d.body_plain());
        let nparts = parts.len();
        let mut citations: Vec<String> = vec![id.clone()];
        for l in &d.links {
            if (l.via == Via::Link || l.via == Via::Prose) && !citations.contains(&l.target) {
                citations.push(l.target.clone());
            }
        }
        for (i, (body_part, start, end)) in parts.into_iter().enumerate() {
            let mut body = body_part;
            if i == nparts - 1 && !tables.is_empty() {
                body.push('\n');
                body.push_str(&tables.join("\n"));
            }
            let text = format!("{}\n{}\n{}", node.breadcrumb, node.context, body);
            out.push(Chunk {
                chunk_id: format!("{expr}#c{i}"),
                expr: expr.clone(),
                id: id.clone(),
                part: i,
                nparts,
                node: d.front.node.clone(),
                label: node.label.clone(),
                title: node.title.clone(),
                breadcrumb: node.breadcrumb.clone(),
                context: node.context.clone(),
                body,
                text,
                line_start: start,
                line_end: end,
                source: d.source.clone(),
                kind: node.kind.clone(),
                effective: d.front.effective,
                superseded: d.front.superseded_by.is_some(),
                citations: citations.clone(),
                terms_defined: d.front.defines.clone(),
            });
        }
    }
    out
}

pub fn save(path: &Path, chunks: &[Chunk]) -> Result<()> {
    let mut s = String::new();
    for c in chunks {
        s.push_str(&serde_json::to_string(c)?);
        s.push('\n');
    }
    std::fs::write(path, s).map_err(|e| SectError::io(path, e))
}

pub fn load(path: &Path) -> Result<Vec<Chunk>> {
    let text = std::fs::read_to_string(path).map_err(|e| SectError::io(path, e))?;
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| Ok(serde_json::from_str(l)?)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_only_at_top_level_labels_when_oversize() {
        let para = |label: &str| format!("({label}) {}", "word ".repeat(900).trim());
        let body = format!("# Heading\n\n{}\n\n(1) sub {}\n\n{}\n\n{}", para("a"), "x ".repeat(300).trim(), para("b"), para("c"));
        let parts = split_body(&body);
        assert!(parts.len() >= 2, "{}", parts.len());
        assert!(parts[1].0.trim_start().starts_with("(b)") || parts[1].0.trim_start().starts_with("(c)"), "{}", &parts[1].0[..40]);
        assert_eq!(parts[0].1, 1);
        assert!(parts[1].1 > parts[0].2);
        let small = split_body("(a) short\n\n(b) text");
        assert_eq!(small.len(), 1);
        assert_eq!(small[0], ("(a) short\n\n(b) text".to_string(), 1, 3));
    }
}
