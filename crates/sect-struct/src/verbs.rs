//! Traversal verbs over the tree and graph: `refs`, `read --history`, `map --complete`.
//! These are the structural guarantees of spec A.4: they never involve ranking.

use chrono::NaiveDate;
use sect_core::split_expr;
use serde::Serialize;

use crate::graph::{Edge, Graph};
use crate::tree::Tree;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    Out,
    Both,
}

impl Direction {
    pub fn parse(s: &str) -> Option<Direction> {
        match s {
            "in" => Some(Direction::In),
            "out" => Some(Direction::Out),
            "both" => Some(Direction::Both),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RefHit {
    pub depth: usize,
    #[serde(flatten)]
    pub edge: Edge,
    /// The endpoint reached from the queried node.
    pub other: String,
}

fn work_of(id: &str) -> &str {
    split_expr(id).0
}

/// Cross-reference / amendment traversal, breadth-first up to the requested depth.
/// With `as_of`, only edges whose far endpoint (and the Expression the edge lives in) are
/// active at that date are followed.
// Preserve the shared verb's established library interface.
#[allow(clippy::too_many_arguments)]
pub fn refs(
    tree: &Tree,
    graph: &Graph,
    id: &str,
    direction: Direction,
    kind: Option<&str>,
    depth: usize,
    as_of: Option<NaiveDate>,
    include_superseded: bool,
) -> Vec<RefHit> {
    let depth = depth.max(1);
    let start = id.trim().to_string();
    let notice_actions: Vec<String> = graph
        .actions_of(&start)
        .iter()
        .map(|a| a.action_id.clone())
        .collect();
    let mut frontier: Vec<String> = vec![start.clone()];
    frontier.extend(notice_actions);
    let mut seen: std::collections::HashSet<String> = frontier.iter().cloned().collect();
    let mut out = Vec::new();
    let active = |endpoint: &str| -> bool {
        let Some(date) = as_of else { return true };
        if endpoint.starts_with("term:") {
            return true;
        }
        if let Some(a) = graph.action(endpoint) {
            return a.effective.map(|d| d <= date).unwrap_or(false);
        }
        if endpoint.contains('@') {
            return tree.active_at(endpoint, date, include_superseded);
        }
        tree.work_active_at(endpoint, date)
    };
    for d in 1..=depth {
        let mut next = Vec::new();
        for cur in &frontier {
            for e in &graph.edges {
                if let Some(k) = kind {
                    if e.kind != k {
                        continue;
                    }
                }
                let outgoing = matches!(direction, Direction::Out | Direction::Both)
                    && (e.from == *cur || e.from_expr == *cur);
                let incoming = matches!(direction, Direction::In | Direction::Both)
                    && (e.to == *cur || work_of(&e.to) == cur);
                if !outgoing && !incoming {
                    continue;
                }
                let other = if outgoing {
                    e.to.clone()
                } else {
                    e.from.clone()
                };
                if outgoing
                    && e.from == *cur
                    && e.from_expr != *cur
                    && as_of.is_some()
                    && !active(&e.from_expr)
                {
                    continue; // edge lives in an Expression not active at the date
                }
                if !outgoing && as_of.is_some() && !active(&e.from_expr) {
                    continue;
                }
                let historical_target = e.kind == "supersedes"
                    && tree
                        .resolve(&other)
                        .map(|(_, r)| {
                            as_of
                                .map(|d| r.effective.map(|e| e <= d).unwrap_or(true))
                                .unwrap_or(true)
                        })
                        .unwrap_or(false);
                if !active(&other) && !historical_target {
                    continue;
                }
                out.push(RefHit {
                    depth: d,
                    edge: e.clone(),
                    other: other.clone(),
                });
                let next_id = work_of(&other).to_string();
                if !next_id.starts_with("term:") && seen.insert(next_id.clone()) {
                    next.push(next_id);
                }
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }
    out.sort_by(|a, b| {
        (
            a.depth,
            &a.edge.from_expr,
            &a.edge.kind,
            &a.edge.to,
            &a.edge.line,
        )
            .cmp(&(
                b.depth,
                &b.edge.from_expr,
                &b.edge.kind,
                &b.edge.to,
                &b.edge.line,
            ))
    });
    out.dedup_by(|a, b| a.edge == b.edge);
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HistoryEntry {
    Expression {
        id: String,
        effective: Option<NaiveDate>,
        path: String,
        supersedes: Option<String>,
        superseded_by: Option<String>,
        citation: Option<String>,
    },
    Action {
        id: String,
        notice: String,
        effective: Option<NaiveDate>,
        action: String,
        target_anchor: Option<String>,
        text: Option<String>,
    },
}

impl HistoryEntry {
    pub fn id(&self) -> &str {
        match self {
            HistoryEntry::Expression { id, .. } | HistoryEntry::Action { id, .. } => id,
        }
    }
}

/// Every Expression of a Work in effective order, with the Actions that produced each later one
/// listed before it (spec B.4 `read --history`).
pub fn history(tree: &Tree, graph: &Graph, work: &str) -> Vec<HistoryEntry> {
    let Some(node) = tree.get(work_of(work)) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (i, e) in node.expressions.iter().enumerate() {
        if i > 0 {
            for a in &e.amended_by {
                out.push(match graph.action(a) {
                    Some(rec) => HistoryEntry::Action {
                        id: rec.action_id.clone(),
                        notice: rec.notice.clone(),
                        effective: rec.effective,
                        action: rec.kind.clone(),
                        target_anchor: rec.target_anchor.clone(),
                        text: rec.text.clone(),
                    },
                    None => HistoryEntry::Action {
                        id: a.clone(),
                        notice: String::new(),
                        effective: None,
                        action: "unknown".into(),
                        target_anchor: None,
                        text: None,
                    },
                });
            }
        }
        out.push(HistoryEntry::Expression {
            id: e.expr.clone(),
            effective: e.effective,
            path: e.path.clone(),
            supersedes: e.supersedes.clone(),
            superseded_by: e.superseded_by.clone(),
            citation: e.citation.clone(),
        });
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MapItem {
    Section {
        id: String,
        label: String,
        title: String,
        level: String,
        depth: usize,
        children: usize,
    },
    Anchor {
        id: String,
        anchor: String,
        depth: usize,
    },
}

impl MapItem {
    pub fn key(&self) -> String {
        match self {
            MapItem::Section { id, .. } => id.clone(),
            MapItem::Anchor { anchor, .. } => anchor.clone(),
        }
    }
}

/// Full subtree by traversal (spec B.3 `map --complete`): under a container, every descendant
/// section; under a section, its top-level paragraph anchors; under `id#anchor`, the anchors
/// nested beneath that paragraph.
pub fn map_complete(tree: &Tree, scope: &str) -> Vec<MapItem> {
    let (work, anchor) = match scope.split_once('#') {
        Some((w, a)) => (w, Some(a)),
        None => (scope, None),
    };
    let Some(node) = tree.get(work) else {
        return vec![];
    };
    if let Some(a) = anchor {
        let prefix = format!("{a}-");
        return node
            .anchors
            .iter()
            .filter(|x| x.starts_with(&prefix))
            .map(|x| MapItem::Anchor {
                id: node.id.clone(),
                anchor: x.clone(),
                depth: 1,
            })
            .collect();
    }
    if !node.children.is_empty() {
        let mut out = Vec::new();
        fn rec(tree: &Tree, id: &str, depth: usize, out: &mut Vec<MapItem>) {
            for c in tree.children(id) {
                out.push(MapItem::Section {
                    id: c.id.clone(),
                    label: c.label.clone(),
                    title: c.title.clone(),
                    level: c.level.clone(),
                    depth,
                    children: c.children.len(),
                });
                rec(tree, &c.id, depth + 1, out);
            }
        }
        rec(tree, &node.id, 1, &mut out);
        return out;
    }
    node.anchors
        .iter()
        .filter(|x| !x.contains('-') && !node.defines.iter().any(|t| sect_corpus::slug(t) == **x))
        .map(|x| MapItem::Anchor {
            id: node.id.clone(),
            anchor: x.clone(),
            depth: 1,
        })
        .collect()
}
