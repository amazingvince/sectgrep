//! Retrieval passages with exact ranges in the pinned, link-stripped Markdown body.

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

use chrono::NaiveDate;
use rayon::prelude::*;
use sect_core::{Result, SectError};
use sect_corpus::{Document, Via};
use sect_struct::Tree;
use serde::{Deserialize, Serialize};

use crate::passages::Budget;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceSpan {
    pub expr: String,
    pub title: String,
    pub breadcrumb: String,
    /// UTF-8 range in the compiled passage body (which may contain several source units).
    pub passage_start: usize,
    pub passage_end: usize,
    pub body_sha256: String,
    /// UTF-8 byte offsets in Document::body_plain(), never offsets into raw PDF bytes.
    pub byte_start: usize,
    pub byte_end: usize,
    pub line_start: usize,
    pub line_end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SupportSpan {
    pub role: String,
    pub text: String,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chunk {
    /// Derived passage address; binds source spans, serialized input and passage recipe.
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
    /// This part's body, with links stripped to their text and tables kept in source order.
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
    #[serde(default)]
    pub recipe: String,
    #[serde(default)]
    pub budget_unit: String,
    #[serde(default)]
    pub token_count: usize,
    #[serde(default)]
    pub spans: Vec<SourceSpan>,
    #[serde(default)]
    pub navigation: bool,
    #[serde(default)]
    pub boundary_fallback: bool,
    #[serde(default)]
    pub support: Vec<SupportSpan>,
    #[serde(default)]
    pub source_document: bool,
}

/// The compiler and its cache use the same effective parent projection.
#[derive(Serialize)]
pub(crate) struct Context {
    pub label: String,
    pub kind: String,
    pub breadcrumb: String,
    pub context: String,
}

pub(crate) fn context(d: &Document, tree: &Tree, today: NaiveDate) -> Option<Context> {
    let id = d.id()?.to_string();
    let node = tree.get(&id)?;
    let date = if d.front.superseded_by.is_some() || d.front.effective.is_some_and(|d| d > today) {
        d.front.effective.unwrap_or(today)
    } else {
        today
    };
    let generated = d.front.context_kind.as_deref() == Some("navigation");
    let mut chain = vec![if generated {
        d.front.title.clone().unwrap_or_default()
    } else {
        format!(
            "{} {}",
            node.label,
            d.front.title.as_deref().unwrap_or_default()
        )
        .trim()
        .to_string()
    }];
    let mut contexts = vec![if generated {
        String::new()
    } else {
        d.front.context_text()
    }];
    let mut seen = std::collections::HashSet::from([id.clone()]);
    let mut parent = d.front.parent.clone();
    while let Some(p) = parent {
        if !seen.insert(p.clone()) {
            break;
        }
        let Some(n) = tree.get(&p) else { break };
        let Some(e) = tree.as_of(&p, date) else { break };
        chain.push(if generated {
            e.front.title.clone().unwrap_or_default()
        } else {
            format!(
                "{} {}",
                n.label,
                e.front.title.as_deref().unwrap_or_default()
            )
            .trim()
            .to_string()
        });
        if !generated {
            contexts.push(e.front.context_text());
        }
        parent = e.front.parent.clone();
    }
    chain.reverse();
    contexts.reverse();
    let breadcrumb = chain.join(" > ");
    let context = contexts
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Some(Context {
        label: node.label.clone(),
        kind: node.kind.clone(),
        breadcrumb,
        context,
    })
}

pub fn build_chunks(
    docs: &[Document],
    tree: &Tree,
    budget: &Budget,
    sources: &crate::regions::SourceIndex,
) -> Result<Vec<Chunk>> {
    build_selected(
        &docs.iter().collect::<Vec<_>>(),
        tree,
        budget,
        sources,
        chrono::Utc::now().date_naive(),
    )
}

pub(crate) fn build_selected(
    docs: &[&Document],
    tree: &Tree,
    budget: &Budget,
    sources: &crate::regions::SourceIndex,
    today: NaiveDate,
) -> Result<Vec<Chunk>> {
    use sha2::{Digest, Sha256};
    let mut native_headers = std::collections::HashMap::new();
    let mut source_expressions = std::collections::HashSet::new();
    for document in sources.documents.values() {
        let regions: std::collections::HashMap<_, _> =
            document.regions.iter().map(|r| (&r.id, r)).collect();
        for unit in &document.units {
            source_expressions.insert(format!("{}@{}", unit.id, document.effective));
            let counts: Vec<usize> = unit
                .regions
                .iter()
                .map(|id| regions[id])
                .filter(|r| r.kind == "table")
                .map(|r| {
                    let mut row = 0;
                    loop {
                        let cells: Vec<_> = r.cells.iter().filter(|c| c.row == row).collect();
                        if cells.is_empty()
                            || cells
                                .iter()
                                .any(|c| !matches!(c.role.as_str(), "header" | "column_header"))
                        {
                            break;
                        }
                        row += 1;
                    }
                    (row as usize).max(1)
                })
                .collect();
            if !counts.is_empty() {
                native_headers.insert(format!("{}@{}", unit.id, document.effective), counts);
            }
        }
    }
    // Compilation is independent per canonical document. Indexed parallel collection
    // retains source order; inspect results in that order so errors stay deterministic.
    let prepared: Vec<Result<Vec<Chunk>>> = docs
        .par_iter()
        .map(|d| {
            let mut out = Vec::new();
            let (Some(id), Some(expr)) = (d.id().map(str::to_string), d.expr()) else {
                return Ok(out);
            };
            let Some(Context {
                label,
                kind,
                breadcrumb,
                context,
            }) = context(d, tree, today)
            else {
                return Ok(out);
            };
            // Tables remain in place in the canonical body. Appending duplicate flattened rows
            // to the final chunk used to evade its budget and attach rows to unrelated paragraphs.
            let canonical = d.body_plain();
            let body_hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
            let navigation = d.front.retrieval_role.as_deref() == Some("navigation")
                || canonical
                    .lines()
                    .all(|l| l.trim().is_empty() || l.trim_start().starts_with('#'));
            let prefix = budget.prefix(&breadcrumb, &context)?;
            let content = if navigation {
                canonical.lines().next().unwrap_or("")
            } else {
                &canonical
            };
            let mut line_offsets: Vec<usize> =
                canonical.match_indices('\n').map(|(i, _)| i + 1).collect();
            line_offsets.insert(0, 0);
            line_offsets.push(canonical.len());
            let mut segments = Vec::new();
            let mut cursor = 0;
            if !navigation {
                for (table_index, table) in d.tables.iter().enumerate() {
                    let start = *line_offsets
                        .get(table.line.saturating_sub(1))
                        .unwrap_or(&canonical.len());
                    let end = *line_offsets
                        .get(table.line + table.rows.len() + 1)
                        .unwrap_or(&canonical.len());
                    let header_rows = native_headers
                        .get(&expr)
                        .filter(|rows| rows.len() == d.tables.len())
                        .and_then(|rows| rows.get(table_index))
                        .copied()
                        .unwrap_or(1);
                    let header_end = *line_offsets
                        .get(table.line + header_rows)
                        .unwrap_or(&canonical.len());
                    if start < cursor || end <= start {
                        continue;
                    }
                    if start > cursor {
                        segments.push((cursor, start, None));
                    }
                    segments.push((start, end, Some((start, header_end.min(end)))));
                    cursor = end;
                }
            }
            if cursor < content.len() || segments.is_empty() {
                segments.push((cursor, content.len(), None));
            }
            let mut parts = Vec::new();
            for (start, end, header) in segments {
                let table_prefix = if let Some((a, b)) = header {
                    let candidate = format!("{prefix}\n{}", &canonical[a..b]);
                    if budget.count(&candidate)? < budget.policy.max * 2 / 3 {
                        candidate
                    } else {
                        prefix.clone()
                    }
                } else {
                    prefix.clone()
                };
                for mut part in budget.split_at_boundaries(
                    &canonical[start..end],
                    &table_prefix,
                    header.is_some(),
                )? {
                    part.start += start;
                    part.end += start;
                    parts.push((part, table_prefix.clone(), header));
                }
            }
            let nparts = parts.len();
            let mut citations: Vec<String> = vec![id.clone()];
            for l in &d.links {
                if (l.via == Via::Link || l.via == Via::Prose) && !citations.contains(&l.target) {
                    citations.push(l.target.clone());
                }
            }
            for (i, (part, prefix, header)) in parts.into_iter().enumerate() {
                let body = canonical[part.start..part.end].to_string();
                let start = canonical[..part.start]
                    .bytes()
                    .filter(|b| *b == b'\n')
                    .count()
                    + 1;
                let end = start + body.lines().count().saturating_sub(1);
                let title = d.front.title.clone().unwrap_or_default();
                let text = format!("{prefix}\n{body}");
                let support = header
                    .filter(|(a, b)| part.start > *a || part.end < *b)
                    .map(|(a, b)| SupportSpan {
                        role: "table_header".into(),
                        text: canonical[a..b].into(),
                        span: SourceSpan {
                            expr: expr.clone(),
                            title: title.clone(),
                            breadcrumb: breadcrumb.clone(),
                            passage_start: 0,
                            passage_end: 0,
                            body_sha256: body_hash.clone(),
                            byte_start: a,
                            byte_end: b,
                            line_start: canonical[..a].bytes().filter(|b| *b == b'\n').count() + 1,
                            line_end: canonical[..b].bytes().filter(|b| *b == b'\n').count() + 1,
                        },
                    })
                    .into_iter()
                    .collect();
                out.push(Chunk {
                    chunk_id: format!("{expr}#c{i}"),
                    expr: expr.clone(),
                    id: id.clone(),
                    part: i,
                    nparts,
                    node: d.front.node.clone(),
                    label: label.clone(),
                    title,
                    breadcrumb: breadcrumb.clone(),
                    context: context.clone(),
                    body,
                    text,
                    line_start: start,
                    line_end: end,
                    source: d.source.clone(),
                    kind: kind.clone(),
                    effective: d.front.effective,
                    superseded: d.front.superseded_by.is_some(),
                    citations: citations.clone(),
                    terms_defined: d.front.defines.clone(),
                    recipe: format!(
                        "{}:{}:{}:{}",
                        crate::passages::RECIPE,
                        budget.unit(),
                        budget.policy.target,
                        budget.policy.max
                    ),
                    budget_unit: budget.unit().into(),
                    token_count: part.count,
                    spans: vec![SourceSpan {
                        expr: expr.clone(),
                        title: d.front.title.clone().unwrap_or_default(),
                        breadcrumb: breadcrumb.clone(),
                        passage_start: 0,
                        passage_end: part.end - part.start,
                        body_sha256: body_hash.clone(),
                        byte_start: part.start,
                        byte_end: part.end,
                        line_start: start,
                        line_end: end,
                    }],
                    navigation,
                    source_document: source_expressions.contains(&expr),
                    boundary_fallback: part.fallback,
                    support,
                });
            }
            Ok(out)
        })
        .collect();
    Ok(prepared
        .into_iter()
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect())
}

/// A passage address changes on rechunking while every canonical expression address stays put.
pub fn bind_addresses(chunks: &mut [Chunk]) -> Result<()> {
    use sha2::{Digest, Sha256};
    for c in chunks {
        let bytes = serde_json::to_vec(&(&c.recipe, &c.spans, &c.text, &c.support))?;
        c.chunk_id = format!("{}#p{:x}", c.expr, Sha256::digest(bytes));
    }
    Ok(())
}

/// Adjacent source-backed leaf peers can share a retrieval passage. Source unit identities,
/// native locators, and exact lexical postings remain independent. Unknown or unrelated scope
/// and legacy Markdown corpora keep their original boundaries.
pub fn merge_peers(
    chunks: Vec<Chunk>,
    sources: &crate::regions::SourceIndex,
    budget: &Budget,
) -> Result<Vec<Chunk>> {
    use std::collections::{HashMap, HashSet};
    let mut by_expr: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, c) in chunks.iter().enumerate() {
        by_expr.entry(&c.expr).or_default().push(i);
    }
    let mut consumed = HashSet::new();
    let mut out = Vec::new();
    for document in sources.documents.values() {
        let mut pending: Option<(Option<String>, Chunk)> = None;
        for u in &document.units {
            let expr = format!("{}@{}", u.id, document.effective);
            let Some(indices) = by_expr.get(expr.as_str()) else {
                continue;
            };
            for &i in indices {
                consumed.insert(i);
                let c = &chunks[i];
                let can_merge = pending.as_ref().is_some_and(|(parent, previous)| {
                    u.parent.is_some()
                        && parent == &u.parent
                        && !previous.navigation
                        && !c.navigation
                        && previous.nparts == 1
                        && c.nparts == 1
                        && previous.kind == c.kind
                        && previous.source == c.source
                        && previous.effective == c.effective
                });
                if can_merge {
                    let (_, previous) = pending.as_mut().expect("checked pending");
                    let scope = c
                        .breadcrumb
                        .rsplit_once(" > ")
                        .map(|(p, _)| p)
                        .unwrap_or(&c.breadcrumb);
                    let prefix = budget.prefix(scope, "")?;
                    let body = format!("{}\n\n{}", previous.body, c.body);
                    let text = format!("{prefix}\n{body}");
                    let count = budget.count(&text)?;
                    // Target limits growth; the hard bound still permits one coherent provision.
                    if count <= budget.policy.max && previous.token_count < budget.policy.target {
                        let offset = previous.body.len() + 2;
                        previous.spans.extend(c.spans.iter().cloned().map(|mut s| {
                            s.passage_start += offset;
                            s.passage_end += offset;
                            s
                        }));
                        previous.body = body;
                        previous.text = text;
                        previous.token_count = count;
                        previous.support.extend(c.support.clone());
                        previous.breadcrumb = scope.into();
                        previous.citations.extend(
                            c.citations
                                .iter()
                                .filter(|id| !previous.citations.contains(id))
                                .cloned()
                                .collect::<Vec<_>>(),
                        );
                        previous.terms_defined.extend(
                            c.terms_defined
                                .iter()
                                .filter(|id| !previous.terms_defined.contains(id))
                                .cloned()
                                .collect::<Vec<_>>(),
                        );
                        continue;
                    }
                }
                if let Some((_, previous)) = pending.take() {
                    out.push(previous);
                }
                pending = Some((u.parent.clone(), c.clone()));
            }
        }
        if let Some((_, previous)) = pending {
            out.push(previous);
        }
    }
    out.extend(
        chunks
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !consumed.contains(i))
            .map(|(_, c)| c),
    );
    out.sort_by(|a, b| a.expr.cmp(&b.expr).then(a.part.cmp(&b.part)));
    Ok(out)
}

impl Chunk {
    pub fn has_expression(&self, expr: &str) -> bool {
        self.expr == expr || self.spans.iter().any(|s| s.expr == expr)
    }
    pub fn selected(&self, allowed: &std::collections::HashSet<String>) -> bool {
        allowed.contains(&self.expr) || self.spans.iter().any(|s| allowed.contains(&s.expr))
    }
    /// Independent lexical postings for source spans route to their shared passage/vector.
    pub fn lexical_documents(&self) -> Vec<sect_lexical::LexDoc> {
        if self.navigation {
            return vec![];
        }
        self.spans
            .iter()
            .enumerate()
            .map(|(i, s)| sect_lexical::LexDoc {
                chunk_id: format!("{}~s{i}", self.chunk_id),
                expr: s.expr.clone(),
                id: sect_core::split_expr(&s.expr).0.into(),
                node: self.node.clone(),
                title: format!("{} {}", self.label, s.title),
                path: s.breadcrumb.clone(),
                context: self.context.clone(),
                body: self.body[s.passage_start..s.passage_end].into(),
                citations: self.citations.clone(),
                terms_defined: self.terms_defined.clone(),
                source: self.source.clone(),
                kind: self.kind.clone(),
                effective: self.effective,
                superseded: self.superseded,
            })
            .collect()
    }
}

/// Preserve native caption/footnote dependencies as source quotations. These are structural
/// links supplied by an adapter, never semantic relations inferred from proximity.
pub fn attach_support(
    chunks: &mut [Chunk],
    docs: &[Document],
    sources: &crate::regions::SourceIndex,
) {
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    let bodies: HashMap<String, (String, String, String)> = docs
        .iter()
        .filter_map(|d| {
            d.expr().map(|expr| {
                let body = d.body_plain();
                let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
                (
                    expr,
                    (body, hash, d.front.title.clone().unwrap_or_default()),
                )
            })
        })
        .collect();
    let mut support_by_expr: HashMap<String, Vec<SupportSpan>> = HashMap::new();
    for doc in sources.documents.values() {
        let owners: HashMap<&str, &str> = doc
            .units
            .iter()
            .flat_map(|u| u.regions.iter().map(move |r| (r.as_str(), u.id.as_str())))
            .collect();
        for region in &doc.regions {
            if region.exclusion.is_some() || region.text.is_empty() {
                continue;
            }
            if region.caption_of.is_none() && region.footnote_of.is_empty() {
                continue;
            }
            let Some(owner) = owners.get(region.id.as_str()) else {
                continue;
            };
            let expr = format!("{owner}@{}", doc.effective);
            let Some((body, hash, title)) = bodies.get(&expr) else {
                continue;
            };
            let mut matches = body.match_indices(&region.text);
            let Some((start, _)) = matches.next() else {
                continue;
            };
            // Ambiguous repeated quotations do not acquire an invented byte location.
            if matches.next().is_some() {
                continue;
            }
            let end = start + region.text.len();
            for (target, role) in region
                .caption_of
                .iter()
                .map(|s| (s, "caption"))
                .chain(region.footnote_of.iter().map(|s| (s, "footnote")))
            {
                let Some(target_owner) = owners.get(target.as_str()) else {
                    continue;
                };
                support_by_expr
                    .entry(format!("{target_owner}@{}", doc.effective))
                    .or_default()
                    .push(SupportSpan {
                        role: role.into(),
                        text: region.text.clone(),
                        span: SourceSpan {
                            expr: expr.clone(),
                            title: title.clone(),
                            breadcrumb: String::new(),
                            passage_start: 0,
                            passage_end: 0,
                            body_sha256: hash.clone(),
                            byte_start: start,
                            byte_end: end,
                            line_start: body[..start].bytes().filter(|b| *b == b'\n').count() + 1,
                            line_end: body[..end].bytes().filter(|b| *b == b'\n').count() + 1,
                        },
                    });
            }
        }
    }
    for chunk in chunks.iter_mut().filter(|c| !c.navigation) {
        for span in &chunk.spans {
            if let Some(support) = support_by_expr.get(&span.expr) {
                for s in support {
                    if !chunk.support.contains(s) {
                        chunk.support.push(s.clone());
                    }
                }
            }
        }
    }
}

pub fn save(path: &Path, chunks: &[Chunk]) -> Result<()> {
    let mut writer = BufWriter::with_capacity(
        1024 * 1024,
        std::fs::File::create(path).map_err(|e| SectError::io(path, e))?,
    );
    for c in chunks {
        serde_json::to_writer(&mut writer, c)?;
        writer
            .write_all(b"\n")
            .map_err(|e| SectError::io(path, e))?;
    }
    writer.flush().map_err(|e| SectError::io(path, e))
}

pub fn load(path: &Path) -> Result<Vec<Chunk>> {
    let mut reader = BufReader::with_capacity(
        1024 * 1024,
        std::fs::File::open(path).map_err(|e| SectError::io(path, e))?,
    );
    let mut line = String::new();
    let mut chunks = Vec::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|e| SectError::io(path, e))?
            == 0
        {
            break;
        }
        if !line.trim().is_empty() {
            chunks.push(serde_json::from_str(&line)?);
        }
    }
    Ok(chunks)
}
