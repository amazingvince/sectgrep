//! The structural graph (spec B.4 "Structural"): `xrefs.jsonl`, `actions.jsonl`, `terms.json`,
//! `tables.jsonl`, all derived from front matter and the markdown AST by traversal.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use chrono::NaiveDate;
use regex::Regex;
use sect_core::{split_expr, Result, SectError};
use sect_corpus::{slug, Document, Via};
use serde::{Deserialize, Serialize};

use crate::tree::Tree;

pub const EDGE_TYPES: &[&str] = &["references", "overrides", "narrows", "supersedes", "amends", "defines"];

/// One edge of the structural graph. `from` and `to` are Work ids, except: `supersedes` edges
/// point at an Expression id, `amends` edges start at an Action id, `defines` edges point at
/// `term:<slug>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Edge {
    pub from: String,
    /// The Expression (or Action) the edge was found in.
    pub from_expr: String,
    pub to: String,
    pub anchor: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub via: Via,
    pub line: Option<usize>,
    pub resolved: bool,
}

/// An Action node from a notice (spec B.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionRec {
    pub action_id: String,
    pub notice: String,
    pub target_id: String,
    pub target_anchor: Option<String>,
    pub kind: String,
    pub effective: Option<NaiveDate>,
    pub text: Option<String>,
    /// The Expression whose `amended_by` lists this Action, if any.
    pub produced: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    pub id: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TermRec {
    pub slug: String,
    pub term: String,
    pub id: String,
    pub expr: String,
    pub anchor: String,
    pub source: String,
    pub line: usize,
    pub definition: String,
    /// Current Works whose body uses the term, with match counts; the defining section excluded.
    pub usages: Vec<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableRec {
    pub id: String,
    pub expr: String,
    pub index: usize,
    pub line: usize,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub flat_rows: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Graph {
    pub edges: Vec<Edge>,
    pub actions: Vec<ActionRec>,
    pub terms: BTreeMap<String, TermRec>,
    pub tables: Vec<TableRec>,
}

fn is_current(tree: &Tree, d: &Document) -> bool {
    match (d.id(), d.expr()) {
        (Some(id), Some(e)) => tree.get(id).map(|n| n.current == e).unwrap_or(false),
        _ => false,
    }
}

pub fn build_graph(docs: &[Document], tree: &Tree) -> Graph {
    let action_ids: HashSet<&str> = docs.iter().flat_map(|d| d.front.actions.iter().map(|a| a.action_id.as_str())).collect();
    let mut g = Graph::default();
    let resolves = |id: &str| -> bool {
        let (work, _) = split_expr(id);
        tree.get(work).is_some()
    };
    for d in docs {
        let (Some(id), Some(expr)) = (d.id().map(str::to_string), d.expr()) else { continue };
        let mut seen: HashSet<(String, Option<String>, usize, Via)> = HashSet::new();
        for l in &d.links {
            if l.target == id {
                continue; // self-references ("paragraph (a) of this section") are not cross-references
            }
            if !seen.insert((l.target.clone(), l.anchor.clone(), l.line, l.via)) {
                continue;
            }
            g.edges.push(Edge {
                from: id.clone(),
                from_expr: expr.clone(),
                to: l.target.clone(),
                anchor: l.anchor.clone(),
                kind: "references".into(),
                via: l.via,
                line: Some(l.line),
                resolved: resolves(&l.target),
            });
        }
        for t in &d.front.overrides {
            g.edges.push(Edge { from: id.clone(), from_expr: expr.clone(), to: t.clone(), anchor: None, kind: "overrides".into(), via: Via::FrontMatter, line: None, resolved: resolves(t) });
        }
        for n in &d.front.narrows {
            g.edges.push(Edge { from: id.clone(), from_expr: expr.clone(), to: n.id.clone(), anchor: n.anchor.clone(), kind: "narrows".into(), via: Via::FrontMatter, line: None, resolved: resolves(&n.id) });
        }
        if let Some(s) = &d.front.supersedes {
            g.edges.push(Edge { from: id.clone(), from_expr: expr.clone(), to: s.clone(), anchor: None, kind: "supersedes".into(), via: Via::FrontMatter, line: None, resolved: tree.resolve(s).is_some() });
        }
        for a in &d.front.amended_by {
            g.edges.push(Edge { from: a.clone(), from_expr: a.clone(), to: id.clone(), anchor: None, kind: "amends".into(), via: Via::FrontMatter, line: None, resolved: action_ids.contains(a.as_str()) });
        }
        for t in &d.front.defines {
            g.edges.push(Edge { from: id.clone(), from_expr: expr.clone(), to: format!("term:{}", slug(t)), anchor: None, kind: "defines".into(), via: Via::FrontMatter, line: None, resolved: true });
        }
        for a in &d.front.actions {
            let produced = docs.iter().find(|x| x.front.amended_by.contains(&a.action_id)).and_then(|x| x.expr());
            g.actions.push(ActionRec {
                action_id: a.action_id.clone(),
                notice: a.notice.clone().unwrap_or_else(|| id.clone()),
                target_id: a.target_id.clone(),
                target_anchor: a.target_anchor.clone(),
                kind: a.kind.clone(),
                effective: a.effective,
                text: a.text.clone(),
                produced,
            });
        }
        for (i, t) in d.tables.iter().enumerate() {
            g.tables.push(TableRec { id: id.clone(), expr: expr.clone(), index: i, line: t.line, header: t.header.clone(), rows: t.rows.clone(), flat_rows: t.flat_rows() });
        }
    }
    // Terms: defined in current Expressions; usages counted over current Expressions of other Works.
    let current: Vec<&Document> = docs.iter().filter(|d| is_current(tree, d)).collect();
    for d in &current {
        let (Some(id), Some(expr)) = (d.id().map(str::to_string), d.expr()) else { continue };
        for def in &d.definitions {
            let pattern = format!(r"(?i)\b{}s?\b", regex::escape(&def.term));
            let re = Regex::new(&pattern).ok();
            let mut usages = Vec::new();
            if let Some(re) = &re {
                for other in &current {
                    let Some(oid) = other.id() else { continue };
                    if oid == id {
                        continue;
                    }
                    let count = re.find_iter(&other.body).count();
                    if count > 0 {
                        usages.push(Usage { id: oid.to_string(), count });
                    }
                }
            }
            usages.sort_by(|a, b| a.id.cmp(&b.id));
            g.terms.insert(
                def.slug.clone(),
                TermRec { slug: def.slug.clone(), term: def.term.clone(), id: id.clone(), expr: expr.clone(), anchor: def.slug.clone(), source: d.source.clone(), line: def.line, definition: def.text.clone(), usages },
            );
        }
    }
    g.edges.sort_by(|a, b| (&a.from_expr, &a.kind, &a.to, &a.line).cmp(&(&b.from_expr, &b.kind, &b.to, &b.line)));
    g
}

impl Graph {
    pub fn unresolved(&self) -> Vec<&Edge> {
        self.edges.iter().filter(|e| !e.resolved).collect()
    }

    pub fn actions_of(&self, notice: &str) -> Vec<&ActionRec> {
        self.actions.iter().filter(|a| a.notice == notice).collect()
    }

    pub fn action(&self, id: &str) -> Option<&ActionRec> {
        self.actions.iter().find(|a| a.action_id == id)
    }

    pub fn term(&self, term: &str) -> Option<&TermRec> {
        self.terms.get(&slug(term))
    }

    pub fn tables_of(&self, expr: &str) -> Vec<&TableRec> {
        self.tables.iter().filter(|t| t.expr == expr).collect()
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        write_jsonl(&dir.join("xrefs.jsonl"), &self.edges)?;
        write_jsonl(&dir.join("actions.jsonl"), &self.actions)?;
        write_jsonl(&dir.join("tables.jsonl"), &self.tables)?;
        let p = dir.join("terms.json");
        std::fs::write(&p, serde_json::to_string_pretty(&self.terms)?).map_err(|e| SectError::io(&p, e))
    }

    pub fn load(dir: &Path) -> Result<Graph> {
        let p = dir.join("terms.json");
        let terms = std::fs::read_to_string(&p).map_err(|e| SectError::io(&p, e))?;
        Ok(Graph {
            edges: read_jsonl(&dir.join("xrefs.jsonl"))?,
            actions: read_jsonl(&dir.join("actions.jsonl"))?,
            tables: read_jsonl(&dir.join("tables.jsonl"))?,
            terms: serde_json::from_str(&terms)?,
        })
    }
}

fn write_jsonl<T: Serialize>(path: &Path, rows: &[T]) -> Result<()> {
    let mut s = String::new();
    for r in rows {
        s.push_str(&serde_json::to_string(r)?);
        s.push('\n');
    }
    std::fs::write(path, s).map_err(|e| SectError::io(path, e))
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>> {
    let text = std::fs::read_to_string(path).map_err(|e| SectError::io(path, e))?;
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| Ok(serde_json::from_str(l)?)).collect()
}
