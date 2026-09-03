use std::collections::BTreeMap;
use std::path::Path;

use chrono::NaiveDate;
use sect_core::{expr_id, Narrow, Result, SectError, SourceConfig, SCHEMA_VERSION};
use sect_corpus::Document;
use serde::{Deserialize, Serialize};

/// One Expression (effective-dated text) of a Work.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExprInfo {
    pub expr: String,
    pub path: String,
    pub effective: Option<NaiveDate>,
    pub supersedes: Option<String>,
    pub superseded_by: Option<String>,
    pub amended_by: Vec<String>,
    pub citation: Option<String>,
}

/// One Work (a section, a container node, an overlay, a notice, or a note).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    pub id: String,
    pub title: String,
    pub level: String,
    pub kind: String,
    pub source: String,
    pub parent: Option<String>,
    pub order: i64,
    /// `§ 2.7`, `Part 2`, `AM-1`.
    pub label: String,
    pub breadcrumb: String,
    /// Expression id of the current text.
    pub current: String,
    pub effective: Option<NaiveDate>,
    pub expressions: Vec<ExprInfo>,
    pub children: Vec<String>,
    pub overridden_by: Vec<String>,
    pub narrowed_by: Vec<Narrow>,
    pub defines: Vec<String>,
    pub anchors: Vec<String>,
    pub context: String,
    pub word_count: usize,
    pub legal_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Tree {
    pub schema_version: u32,
    pub nodes: BTreeMap<String, Node>,
    pub roots: Vec<String>,
}

fn level_word(level: &str) -> String {
    match level {
        "title" => "Title".into(),
        "chapter" => "Chapter".into(),
        "subchapter" => "Subchapter".into(),
        "part" => "Part".into(),
        other => {
            let mut c = other.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        }
    }
}

fn label_for(id: &str, level: &str, src: &SourceConfig) -> String {
    let tail = id.strip_prefix(&src.id_prefix).unwrap_or_else(|| id.split_once(':').map(|(_, t)| t).unwrap_or(id));
    if src.is_base() {
        let num = tail.rsplit('-').next().unwrap_or(tail);
        if level == "section" {
            format!("§ {num}")
        } else {
            format!("{} {num}", level_word(level))
        }
    } else {
        tail.to_string()
    }
}

/// Build the tree from every parsed document. The current Expression of a Work is the latest
/// one that is not superseded (or the latest overall if all are).
pub fn build_tree(docs: &[Document], sources: &BTreeMap<String, SourceConfig>) -> Tree {
    let mut groups: BTreeMap<String, Vec<&Document>> = BTreeMap::new();
    for d in docs {
        if let Some(id) = d.id() {
            groups.entry(id.to_string()).or_default().push(d);
        }
    }
    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    for (id, mut exprs) in groups {
        exprs.sort_by_key(|d| d.front.effective);
        let cur = exprs.iter().rev().find(|d| d.front.superseded_by.is_none()).copied().unwrap_or(*exprs.last().unwrap());
        let src = sources.get(&cur.source).cloned().unwrap_or_default();
        let level = cur.front.level.clone().unwrap_or_else(|| "section".into());
        let expressions = exprs
            .iter()
            .map(|d| ExprInfo {
                expr: expr_id(&id, d.front.effective),
                path: d.rel.clone(),
                effective: d.front.effective,
                supersedes: d.front.supersedes.clone(),
                superseded_by: d.front.superseded_by.clone(),
                amended_by: d.front.amended_by.clone(),
                citation: d.front.citation.clone(),
            })
            .collect();
        nodes.insert(
            id.clone(),
            Node {
                label: label_for(&id, &level, &src),
                id: id.clone(),
                title: cur.front.title.clone().unwrap_or_default(),
                level,
                kind: cur.front.kind.clone().unwrap_or_else(|| src.kind.clone()),
                source: cur.source.clone(),
                parent: cur.front.parent.clone(),
                order: cur.front.order.unwrap_or(0),
                breadcrumb: String::new(),
                current: expr_id(&id, cur.front.effective),
                effective: cur.front.effective,
                expressions,
                children: Vec::new(),
                overridden_by: Vec::new(),
                narrowed_by: Vec::new(),
                defines: cur.front.defines.clone(),
                anchors: cur.anchors(),
                context: cur.front.context_text(),
                word_count: cur.word_count,
                legal_status: cur.front.provenance.as_ref().and_then(|p| p.legal_status.clone()).unwrap_or_else(|| src.legal_status.clone()),
            },
        );
    }
    // children, overrides, narrows (one map from Expression to document; a scan per node was
    // quadratic and cost 13 s at 10k sections)
    let by_expr: std::collections::HashMap<String, &Document> = docs.iter().filter_map(|d| d.expr().map(|e| (e, d))).collect();
    let ids: Vec<String> = nodes.keys().cloned().collect();
    for id in &ids {
        let (parent, overrides, narrows) = {
            let n = &nodes[id];
            let d = by_expr.get(n.current.as_str()).copied();
            (n.parent.clone(), d.map(|d| d.front.overrides.clone()).unwrap_or_default(), d.map(|d| d.front.narrows.clone()).unwrap_or_default())
        };
        if let Some(p) = parent {
            if let Some(pn) = nodes.get_mut(&p) {
                pn.children.push(id.clone());
            }
        }
        for t in overrides {
            if let Some(tn) = nodes.get_mut(&t) {
                tn.overridden_by.push(id.clone());
            }
        }
        for n in narrows {
            if let Some(tn) = nodes.get_mut(&n.id) {
                tn.narrowed_by.push(Narrow { id: id.clone(), anchor: n.anchor });
            }
        }
    }
    let order_key = |nodes: &BTreeMap<String, Node>, id: &String| (nodes[id].order, id.clone());
    for id in &ids {
        let mut kids = std::mem::take(&mut nodes.get_mut(id).unwrap().children);
        kids.sort_by_key(|k| order_key(&nodes, k));
        nodes.get_mut(id).unwrap().children = kids;
    }
    let mut roots: Vec<String> = ids.iter().filter(|id| nodes[*id].parent.is_none()).cloned().collect();
    roots.sort_by_key(|id| {
        let n = &nodes[id];
        let prec = sources.get(&n.source).map(|s| -s.precedence).unwrap_or(0);
        (if n.kind == "base" { 0 } else { 1 }, prec, n.order, id.clone())
    });
    // breadcrumbs
    for id in &ids {
        let crumb = breadcrumb(&nodes, id, sources);
        nodes.get_mut(id).unwrap().breadcrumb = crumb;
    }
    Tree { schema_version: SCHEMA_VERSION, nodes, roots }
}

fn breadcrumb(nodes: &BTreeMap<String, Node>, id: &str, sources: &BTreeMap<String, SourceConfig>) -> String {
    let n = &nodes[id];
    let src = sources.get(&n.source).cloned().unwrap_or_default();
    if src.is_base() {
        let mut chain = vec![id.to_string()];
        let mut cur = n;
        let mut guard = 0;
        while let Some(p) = &cur.parent {
            guard += 1;
            match nodes.get(p) {
                Some(pn) if guard < 32 => {
                    chain.push(p.clone());
                    cur = pn;
                }
                _ => break,
            }
        }
        chain.iter().rev().map(|i| format!("{} {}", nodes[i].label, nodes[i].title).trim().to_string()).collect::<Vec<_>>().join(" > ")
    } else {
        format!("{} > {} {}", src.display_title(), n.label, n.title).trim().to_string()
    }
}

impl Tree {
    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Resolve a Work id or an Expression id to (node, expression).
    pub fn resolve(&self, r: &str) -> Option<(&Node, &ExprInfo)> {
        let (work, date) = sect_core::split_expr(r);
        let node = self.nodes.get(work)?;
        let expr = match date {
            Some(_) => node.expressions.iter().find(|e| e.expr == r)?,
            None => node.expressions.iter().find(|e| e.expr == node.current)?,
        };
        Some((node, expr))
    }

    /// Snap to the nearest published Expression on or before `date` (spec B.4 `--as-of`).
    pub fn as_of(&self, work: &str, date: NaiveDate) -> Option<&ExprInfo> {
        let node = self.nodes.get(work)?;
        node.expressions.iter().filter(|e| e.effective.map(|d| d <= date).unwrap_or(false)).last()
    }

    /// Is this Expression the active text of its Work at `date`? With `include_superseded`,
    /// any Expression already published by `date` counts.
    pub fn active_at(&self, expr: &str, date: NaiveDate, include_superseded: bool) -> bool {
        let (work, _) = sect_core::split_expr(expr);
        match self.resolve(expr) {
            Some((_, e)) => {
                let published = e.effective.map(|d| d <= date).unwrap_or(false);
                if include_superseded {
                    published
                } else {
                    self.as_of(work, date).map(|s| s.expr == e.expr).unwrap_or(false)
                }
            }
            None => false,
        }
    }

    /// Is the Work active at `date` at all (some Expression published by then)?
    pub fn work_active_at(&self, work: &str, date: NaiveDate) -> bool {
        self.as_of(work, date).is_some()
    }

    /// The scope (or the node itself) is on the ancestor chain of `id`.
    pub fn within(&self, id: &str, scope: &str) -> bool {
        id == scope || self.ancestors(id).iter().any(|a| a.id == scope)
    }

    pub fn ancestors(&self, id: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        let mut cur = self.nodes.get(id);
        while let Some(n) = cur {
            match n.parent.as_deref().and_then(|p| self.nodes.get(p)) {
                Some(p) if out.len() < 32 => {
                    out.push(p);
                    cur = Some(p);
                }
                _ => break,
            }
        }
        out
    }

    pub fn children(&self, id: &str) -> Vec<&Node> {
        self.nodes.get(id).map(|n| n.children.iter().filter_map(|c| self.nodes.get(c)).collect()).unwrap_or_default()
    }

    /// Depth-first walk under `scope` (or all roots), yielding (depth, node), depth-limited.
    pub fn walk(&self, scope: Option<&str>, max_depth: usize) -> Vec<(usize, &Node)> {
        let mut out = Vec::new();
        let starts: Vec<&Node> = match scope {
            Some(s) => self.nodes.get(s).into_iter().collect(),
            None => self.roots.iter().filter_map(|r| self.nodes.get(r)).collect(),
        };
        fn rec<'a>(t: &'a Tree, n: &'a Node, depth: usize, max: usize, out: &mut Vec<(usize, &'a Node)>) {
            out.push((depth, n));
            if depth >= max {
                return;
            }
            for c in &n.children {
                if let Some(cn) = t.nodes.get(c) {
                    rec(t, cn, depth + 1, max, out);
                }
            }
        }
        for s in starts {
            rec(self, s, 0, max_depth, &mut out);
        }
        out
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        let works = self.nodes.len();
        let expressions: usize = self.nodes.values().map(|n| n.expressions.len()).sum();
        let superseded: usize = self.nodes.values().map(|n| n.expressions.iter().filter(|e| e.superseded_by.is_some()).count()).sum();
        (works, expressions, superseded)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json).map_err(|e| SectError::io(path, e))
    }

    pub fn load(path: &Path) -> Result<Tree> {
        let text = std::fs::read_to_string(path).map_err(|e| SectError::io(path, e))?;
        Ok(serde_json::from_str(&text)?)
    }
}
