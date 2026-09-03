//! Verbs (spec B.3). Every verb returns a [`Response`] whose header carries the freshness and
//! counts lines. Milestone 1: `read`, `map`, `status`. Milestone 2 adds `refs`, `define`,
//! `map --complete`, `read --history`, `--as-of`; milestones 3-5 add `grep` and `search`.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use sect_core::{Counts, Freshness, Header, Narrow, Response, Result, SectError};
use sect_corpus::Issue;
use sect_index::{Index, SourceSummary};
use sect_struct::Node;
use serde::Serialize;

fn header(index: &Index, shown: usize, matched: usize, extra: Vec<(String, usize)>) -> Header {
    let m = &index.manifest;
    Header {
        freshness: index.freshness.clone(),
        counts: Counts {
            shown,
            matched,
            works: m.works,
            expressions: m.expressions,
            superseded: m.superseded,
            sources: m.sources.len(),
            extra,
        },
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Brief {
    pub id: String,
    pub label: String,
    pub title: String,
    pub level: String,
}

impl From<&Node> for Brief {
    fn from(n: &Node) -> Self {
        Brief { id: n.id.clone(), label: n.label.clone(), title: n.title.clone(), level: n.level.clone() }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    pub ancestors: bool,
    pub children: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadResult {
    pub id: String,
    pub expr: String,
    pub title: String,
    pub label: String,
    pub breadcrumb: String,
    pub level: String,
    pub kind: String,
    pub source: String,
    pub legal_status: String,
    pub effective: Option<NaiveDate>,
    pub supersedes: Option<String>,
    pub superseded_by: Option<String>,
    pub amended_by: Vec<String>,
    pub overridden_by: Vec<String>,
    pub narrowed_by: Vec<Narrow>,
    pub expressions: usize,
    pub path: String,
    pub context: String,
    pub anchors: Vec<String>,
    pub ancestors: Vec<Brief>,
    pub children: Vec<Brief>,
    pub body: String,
}

/// `sect read <id[@date]>`: the section text with its structural context.
pub fn read(index: &Index, id: &str, opts: &ReadOptions) -> Result<Response<ReadResult>> {
    let id = id.trim();
    let (node, expr) = index.tree.resolve(id).ok_or_else(|| SectError::NotFound(id.to_string()))?;
    let body = index.read_body(&expr.path)?;
    let result = ReadResult {
        id: node.id.clone(),
        expr: expr.expr.clone(),
        title: node.title.clone(),
        label: node.label.clone(),
        breadcrumb: node.breadcrumb.clone(),
        level: node.level.clone(),
        kind: node.kind.clone(),
        source: node.source.clone(),
        legal_status: node.legal_status.clone(),
        effective: expr.effective,
        supersedes: expr.supersedes.clone(),
        superseded_by: expr.superseded_by.clone(),
        amended_by: expr.amended_by.clone(),
        overridden_by: node.overridden_by.clone(),
        narrowed_by: node.narrowed_by.clone(),
        expressions: node.expressions.len(),
        path: expr.path.clone(),
        context: node.context.clone(),
        anchors: node.anchors.clone(),
        ancestors: if opts.ancestors { index.tree.ancestors(&node.id).into_iter().map(Brief::from).collect() } else { vec![] },
        children: if opts.children { index.tree.children(&node.id).into_iter().map(Brief::from).collect() } else { vec![] },
        body,
    };
    Ok(Response { header: header(index, 1, 1, vec![]), result })
}

#[derive(Debug, Clone, Serialize)]
pub struct MapEntry {
    pub depth: usize,
    pub id: String,
    pub label: String,
    pub title: String,
    pub level: String,
    pub kind: String,
    pub children: usize,
    pub effective: Option<NaiveDate>,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapResult {
    pub scope: Option<String>,
    pub depth: usize,
    pub budget: usize,
    /// Rough token count of the rendered entries (words), used against `budget`.
    pub tokens: usize,
    pub truncated: bool,
    pub total: usize,
    pub entries: Vec<MapEntry>,
}

/// `sect map [--scope id] [--depth n] [--budget tokens]`: table of contents, bounded by a token budget.
pub fn map(index: &Index, scope: Option<&str>, depth: usize, budget: usize) -> Result<Response<MapResult>> {
    if let Some(s) = scope {
        if index.tree.get(s).is_none() {
            return Err(SectError::NotFound(s.to_string()));
        }
    }
    let walked = index.tree.walk(scope, depth);
    let total = walked.len();
    let mut entries = Vec::new();
    let mut tokens = 0usize;
    let mut truncated = false;
    for (d, n) in walked {
        let line_tokens = 2 + n.label.split_whitespace().count() + n.title.split_whitespace().count();
        if tokens + line_tokens > budget {
            truncated = true;
            break;
        }
        tokens += line_tokens;
        let mut flags = Vec::new();
        if !n.overridden_by.is_empty() {
            flags.push(format!("overridden-by {}", n.overridden_by.join(",")));
        }
        if !n.narrowed_by.is_empty() {
            flags.push(format!(
                "narrowed-by {}",
                n.narrowed_by.iter().map(|x| format!("{}#{}", x.id, x.anchor.clone().unwrap_or_default())).collect::<Vec<_>>().join(",")
            ));
        }
        if n.expressions.len() > 1 {
            flags.push(format!("{} expressions", n.expressions.len()));
        }
        entries.push(MapEntry {
            depth: d,
            id: n.id.clone(),
            label: n.label.clone(),
            title: n.title.clone(),
            level: n.level.clone(),
            kind: n.kind.clone(),
            children: n.children.len(),
            effective: n.effective,
            flags,
        });
    }
    let shown = entries.len();
    let result = MapResult { scope: scope.map(str::to_string), depth, budget, tokens, truncated, total, entries };
    Ok(Response { header: header(index, shown, total, vec![]), result })
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResult {
    pub corpus_root: String,
    pub index_dir: String,
    pub built_at: String,
    pub sect_version: String,
    pub schema_version: u32,
    pub freshness: Freshness,
    pub files: usize,
    pub works: usize,
    pub expressions: usize,
    pub superseded: usize,
    pub sources: Vec<SourceSummary>,
    /// Works per legal status (official / unofficial-xml / derived).
    pub legal_status: BTreeMap<String, usize>,
    pub layers: BTreeMap<String, bool>,
    pub warnings: Vec<Issue>,
    pub unresolved_refs: usize,
    pub build_ms: u128,
}

/// `sect status`: freshness, counts, warnings, legal-status summary (spec B.3).
pub fn status(index: &Index) -> Result<Response<StatusResult>> {
    let m = &index.manifest;
    let mut legal: BTreeMap<String, usize> = BTreeMap::new();
    for n in index.tree.nodes.values() {
        *legal.entry(n.legal_status.clone()).or_default() += 1;
    }
    let result = StatusResult {
        corpus_root: m.corpus_root.clone(),
        index_dir: index.root.join(sect_core::INDEX_DIR).to_string_lossy().replace('\\', "/"),
        built_at: m.built_at.clone(),
        sect_version: m.sect_version.clone(),
        schema_version: m.schema_version,
        freshness: index.freshness.clone(),
        files: m.files,
        works: m.works,
        expressions: m.expressions,
        superseded: m.superseded,
        sources: m.sources.clone(),
        legal_status: legal,
        layers: m.layers.clone(),
        warnings: m.warnings.clone(),
        unresolved_refs: m.unresolved_refs,
        build_ms: m.build_ms,
    };
    let extra = vec![("warnings".to_string(), m.warnings.len()), ("unresolved-refs".to_string(), m.unresolved_refs)];
    Ok(Response { header: header(index, m.works, m.works, extra), result })
}
