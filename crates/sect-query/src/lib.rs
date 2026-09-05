//! Verbs (spec B.3). Every verb returns a [`Response`] whose header carries the freshness and
//! counts lines. Milestones 1-2: `read`, `map`, `refs`, `define`, `status`. Milestones 3-5 add
//! `grep` and `search`.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use sect_core::{split_anchor, Counts, Freshness, Header, Narrow, Response, Result, SectError};
use sect_corpus::document::paragraph_anchors;
use sect_corpus::Issue;
use sect_index::{Index, SourceSummary};
use sect_struct::{
    Direction, Edge, HistoryEntry, MapItem, Node, RefHit, TableRec, Usage, EDGE_TYPES,
};
use serde::Serialize;
mod concepts;
mod connected;
pub mod evidence;
pub use concepts::ConceptMatch;
mod knowledge_refs;
mod passage_read;
pub use connected::{RelationMode, RetrievalPath, TraversalReport};
pub use passage_read::PassageRead;

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

fn not_found_as_of(index: &Index, work: &str, date: NaiveDate) -> SectError {
    let earliest = index
        .tree
        .get(work)
        .and_then(|n| n.expressions.first())
        .map(|e| e.expr.clone());
    match earliest {
        Some(e) => SectError::NotFound(format!("{work} as of {date} (earliest Expression is {e})")),
        None => SectError::NotFound(format!("{work} as of {date}")),
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
        Brief {
            id: n.id.clone(),
            label: n.label.clone(),
            title: n.title.clone(),
            level: n.level.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    pub ancestors: bool,
    pub children: bool,
    pub tables: bool,
    pub history: bool,
    pub as_of: Option<NaiveDate>,
    pub version: Option<String>,
    pub include_superseded: bool,
}

/// An overlay marker inserted into the body: `overridden-by` at the heading, `narrowed-by` at
/// the affected paragraph (spec B.4).
#[derive(Debug, Clone, Serialize)]
pub struct Marker {
    pub kind: String,
    pub overlay: String,
    pub anchor: Option<String>,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadResult {
    /// Present only when reading a derived passage address. Ordinary section reads stay lazy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage: Option<PassageRead>,
    pub id: String,
    pub expr: String,
    pub anchor: Option<String>,
    pub as_of: Option<NaiveDate>,
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
    pub history: Vec<HistoryEntry>,
    pub tables: Vec<TableRec>,
    pub markers: Vec<Marker>,
    pub body: String,
    pub provenance: Option<sect_core::Provenance>,
    pub source_regions: Vec<SourceRegion>,
    pub source_region_count: usize,
    pub identity_transitions: Vec<sect_core::regions::IdentityTransition>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceRegion {
    pub id: String,
    pub kind: String,
    pub locator: sect_core::knowledge::Locator,
    pub parent: Option<String>,
    pub uncertainty: Vec<String>,
}

fn overlay_note(index: &Index, overlay: &str) -> String {
    match index.tree.get(overlay) {
        Some(n) => format!(
            "(effective {}): {}",
            n.effective
                .map(|d| d.to_string())
                .unwrap_or_else(|| "n/a".into()),
            n.title
        ),
        None => String::new(),
    }
}

/// `sect read <id[#anchor]>`: the section text with its structural context, overlay markers
/// inline, and optionally its ancestors, children, tables, and history.
pub fn read(index: &Index, id: &str, opts: &ReadOptions) -> Result<Response<ReadResult>> {
    if passage_read::is_address(id.trim()) {
        return passage_read::read(index, id.trim(), opts);
    }
    let (target, anchor) = split_anchor(id.trim());
    let (work, _) = sect_core::split_expr(target);
    if let Some(v) = &opts.version {
        if sect_core::split_expr(v).0 != work {
            return Err(SectError::Other(
                "--version must belong to the requested Work".into(),
            ));
        }
    }
    let explicit = opts.version.as_deref().unwrap_or(target);
    let date = opts
        .as_of
        .or_else(|| {
            index
                .tree
                .resolve(explicit)
                .filter(|(_, e)| explicit == e.expr)
                .and_then(|(_, e)| e.effective)
        })
        .unwrap_or_else(|| index.snapshot_date());
    let snapshot = index.at(date);
    let index = &snapshot;
    let (node, expr) = if let Some(v) = &opts.version {
        index
            .tree
            .resolve(v)
            .ok_or_else(|| SectError::NotFound(v.clone()))?
    } else if let Some(date) = opts.as_of {
        let node = index
            .tree
            .get(work)
            .ok_or_else(|| SectError::NotFound(work.to_string()))?;
        let e = index
            .tree
            .as_of(work, date)
            .ok_or_else(|| not_found_as_of(index, work, date))?;
        (node, e)
    } else {
        index
            .tree
            .resolve(target)
            .ok_or_else(|| SectError::NotFound(target.to_string()))?
    };
    let raw = index.read_body(&expr.path)?;
    let anchor_lines = paragraph_anchors(&raw);
    let lines: Vec<&str> = raw.lines().collect();
    let (start, end) = match anchor {
        None => (1usize, lines.len()),
        Some(a) => {
            let pos = anchor_lines
                .iter()
                .position(|x| x.anchor == a)
                .ok_or_else(|| {
                    SectError::NotFound(format!(
                        "{}#{a} (anchors: {})",
                        node.id,
                        node.anchors.join(", ")
                    ))
                })?;
            let depth = a.matches('-').count();
            let start = anchor_lines[pos].line;
            let end = anchor_lines[pos + 1..]
                .iter()
                .find(|x| x.anchor.matches('-').count() <= depth)
                .map(|x| x.line - 1)
                .unwrap_or(lines.len());
            (start, end)
        }
    };
    let mut markers = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut banner_done = false;
    for ln in start..=end.max(start) {
        let Some(line) = lines.get(ln - 1) else { break };
        for n in &node.narrowed_by {
            if let Some(a) = &n.anchor {
                if anchor_lines.iter().any(|x| &x.anchor == a && x.line == ln) {
                    let text = format!("> narrowed-by {}#{a} {}", n.id, overlay_note(index, &n.id));
                    markers.push(Marker {
                        kind: "narrowed-by".into(),
                        overlay: n.id.clone(),
                        anchor: Some(a.clone()),
                        line: ln,
                        text: text.clone(),
                    });
                    out.push(text);
                }
            }
        }
        out.push(line.to_string());
        if !banner_done && !node.overridden_by.is_empty() && (line.starts_with('#') || ln == end) {
            for o in &node.overridden_by {
                let text = format!("> overridden-by {o} {}", overlay_note(index, o));
                markers.push(Marker {
                    kind: "overridden-by".into(),
                    overlay: o.clone(),
                    anchor: None,
                    line: ln,
                    text: text.clone(),
                });
                out.push(text);
            }
            banner_done = true;
        }
    }
    if !banner_done && !node.overridden_by.is_empty() {
        for o in &node.overridden_by {
            let text = format!("> overridden-by {o} {}", overlay_note(index, o));
            markers.push(Marker {
                kind: "overridden-by".into(),
                overlay: o.clone(),
                anchor: None,
                line: 0,
                text: text.clone(),
            });
            out.insert(0, text);
        }
    }
    let source_index = index.regions()?;
    let source_unit = source_index.unit(&expr.expr);
    let result = ReadResult {
        passage: None,
        id: node.id.clone(),
        expr: expr.expr.clone(),
        anchor: anchor.map(str::to_string),
        as_of: opts.as_of,
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
        ancestors: if opts.ancestors {
            index
                .tree
                .ancestors(&node.id)
                .into_iter()
                .map(Brief::from)
                .collect()
        } else {
            vec![]
        },
        children: if opts.children {
            index
                .tree
                .children(&node.id)
                .into_iter()
                .map(Brief::from)
                .collect()
        } else {
            vec![]
        },
        history: if opts.history {
            sect_struct::history(&index.tree, &index.graph, &node.id)
        } else {
            vec![]
        },
        tables: if opts.tables {
            index
                .graph
                .tables_of(&expr.expr)
                .into_iter()
                .cloned()
                .collect()
        } else {
            vec![]
        },
        markers,
        body: out.join("\n"),
        provenance: expr.front.provenance.clone(),
        source_regions: source_unit
            .map(|(document, unit)| {
                unit.regions
                    .iter()
                    .take(20)
                    .filter_map(|id| document.regions.iter().find(|r| &r.id == id))
                    .map(|r| SourceRegion {
                        id: r.id.clone(),
                        kind: r.kind.clone(),
                        locator: r.locator.clone(),
                        parent: r.parent.clone(),
                        uncertainty: r.uncertainty.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        source_region_count: source_unit.map(|(_, u)| u.regions.len()).unwrap_or(0),
        identity_transitions: if opts.history {
            source_index
                .identities
                .values()
                .flat_map(|l| &l.transitions)
                .filter(|t| t.from.contains(&node.id) || t.to.contains(&node.id))
                .cloned()
                .collect()
        } else {
            vec![]
        },
    };
    Ok(Response {
        header: header(index, 1, 1, vec![]),
        result,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct MapEntry {
    pub depth: usize,
    pub kind: String,
    pub id: String,
    pub anchor: Option<String>,
    pub label: String,
    pub title: String,
    pub level: String,
    pub children: usize,
    pub effective: Option<NaiveDate>,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapResult {
    pub concepts: Vec<ConceptMatch>,
    pub scope: Option<String>,
    pub complete: bool,
    pub depth: usize,
    pub budget: usize,
    /// Rough token count of the rendered entries (words), used against `budget`.
    pub tokens: usize,
    pub truncated: bool,
    pub total: usize,
    pub entries: Vec<MapEntry>,
}

pub fn map_concepts(
    index: &Index,
    query: &str,
    scope: Option<&str>,
    budget: usize,
    complete: bool,
) -> Result<Response<MapResult>> {
    if scope.is_some_and(|s| index.tree.get(s).is_none()) {
        return Err(SectError::NotFound(scope.unwrap().into()));
    }
    let matches = concepts::lookup(index, query, scope);
    let total = matches.len();
    let mut concepts = Vec::new();
    let mut tokens = 0;
    for matched in matches {
        let words = matched.concept.label.split_whitespace().count()
            + matched
                .concept
                .definition
                .as_deref()
                .unwrap_or("")
                .split_whitespace()
                .count()
            + matched.mentions.len() * 2
            + 4;
        if !complete && tokens + words > budget {
            continue;
        }
        tokens += words;
        concepts.push(matched);
    }
    let shown = concepts.len();
    Ok(Response {
        header: header(index, shown, total, vec![]),
        result: MapResult {
            scope: scope.map(str::to_string),
            complete,
            depth: 1,
            budget,
            tokens,
            truncated: shown < total,
            total,
            concepts,
            entries: vec![],
        },
    })
}

fn node_flags(n: &Node) -> Vec<String> {
    let mut flags = Vec::new();
    if !n.overridden_by.is_empty() {
        flags.push(format!("overridden-by {}", n.overridden_by.join(",")));
    }
    if !n.narrowed_by.is_empty() {
        flags.push(format!(
            "narrowed-by {}",
            n.narrowed_by
                .iter()
                .map(|x| format!("{}#{}", x.id, x.anchor.clone().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    if n.expressions.len() > 1 {
        flags.push(format!("{} expressions", n.expressions.len()));
    }
    flags
}

/// `sect map [--scope id[#anchor]] [--depth n] [--budget tokens] [--complete]`: table of contents
/// bounded by a token budget, or the full subtree by traversal with `--complete`.
pub fn map(
    index: &Index,
    scope: Option<&str>,
    depth: usize,
    budget: usize,
    complete: bool,
) -> Result<Response<MapResult>> {
    if let Some(s) = scope {
        let (work, _) = split_anchor(s);
        if index.tree.get(work).is_none() {
            return Err(SectError::NotFound(work.to_string()));
        }
    }
    let mut entries = Vec::new();
    let mut tokens = 0usize;
    let mut truncated = false;
    let total;
    if complete {
        let s = scope
            .ok_or_else(|| SectError::Other("map --complete needs --scope <id[#anchor]>".into()))?;
        let items = sect_struct::map_complete(&index.tree, s);
        total = items.len();
        for item in items {
            entries.push(match item {
                MapItem::Section {
                    id,
                    label,
                    title,
                    level,
                    depth,
                    children,
                } => {
                    let n = index.tree.get(&id);
                    tokens +=
                        2 + label.split_whitespace().count() + title.split_whitespace().count();
                    MapEntry {
                        depth,
                        kind: "section".into(),
                        id,
                        anchor: None,
                        label,
                        title,
                        level,
                        children,
                        effective: n.and_then(|n| n.effective),
                        flags: n.map(node_flags).unwrap_or_default(),
                    }
                }
                MapItem::Anchor { id, anchor, depth } => {
                    tokens += 1;
                    let n = index.tree.get(&id);
                    let narrowed = n
                        .map(|n| {
                            n.narrowed_by
                                .iter()
                                .filter(|x| x.anchor.as_deref() == Some(anchor.as_str()))
                                .map(|x| format!("narrowed-by {}", x.id))
                                .collect()
                        })
                        .unwrap_or_default();
                    MapEntry {
                        depth,
                        kind: "anchor".into(),
                        id,
                        anchor: Some(anchor),
                        label: String::new(),
                        title: String::new(),
                        level: "paragraph".into(),
                        children: 0,
                        effective: None,
                        flags: narrowed,
                    }
                }
            });
        }
    } else {
        let walked = index.tree.walk(scope, depth);
        total = walked.len();
        for (d, n) in walked {
            let line_tokens =
                2 + n.label.split_whitespace().count() + n.title.split_whitespace().count();
            if tokens + line_tokens > budget {
                truncated = true;
                break;
            }
            tokens += line_tokens;
            entries.push(MapEntry {
                depth: d,
                kind: "section".into(),
                id: n.id.clone(),
                anchor: None,
                label: n.label.clone(),
                title: n.title.clone(),
                level: n.level.clone(),
                children: n.children.len(),
                effective: n.effective,
                flags: node_flags(n),
            });
        }
    }
    let shown = entries.len();
    let result = MapResult {
        concepts: vec![],
        scope: scope.map(str::to_string),
        complete,
        depth,
        budget,
        tokens,
        truncated,
        total,
        entries,
    };
    Ok(Response {
        header: header(index, shown, total, vec![]),
        result,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct RefEntry {
    pub depth: usize,
    #[serde(flatten)]
    pub edge: Edge,
    pub other: String,
    pub other_title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefsResult {
    pub knowledge: Vec<knowledge_refs::KnowledgeRef>,
    pub knowledge_truncated: bool,
    pub id: String,
    pub direction: Direction,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub depth: usize,
    pub as_of: Option<NaiveDate>,
    pub include_superseded: bool,
    pub hits: Vec<RefEntry>,
}

fn title_of(index: &Index, id: &str) -> String {
    let (work, _) = sect_core::split_expr(id);
    if let Some(n) = index.tree.get(work) {
        return n.title.clone();
    }
    if let Some(t) = id.strip_prefix("term:") {
        return index
            .graph
            .term(t)
            .map(|r| format!("term: {}", r.term))
            .unwrap_or_else(|| format!("term: {t}"));
    }
    if let Some(a) = index.graph.action(id) {
        return format!(
            "{} {}{}",
            a.kind,
            a.target_id,
            a.target_anchor
                .as_ref()
                .map(|x| format!("#{x}"))
                .unwrap_or_default()
        );
    }
    String::new()
}

/// `sect refs <id> [--direction in|out|both] [--type T] [--depth n] [--as-of DATE]`: the
/// blast-radius verb. Pure traversal over `xrefs.jsonl`.
pub fn refs(
    index: &Index,
    id: &str,
    direction: Direction,
    kind: Option<&str>,
    depth: usize,
    as_of: Option<NaiveDate>,
    include_superseded: bool,
) -> Result<Response<RefsResult>> {
    let snapshot = index.at(as_of.unwrap_or_else(|| index.snapshot_date()));
    let index = &snapshot;
    if let Some(k) = kind {
        if !EDGE_TYPES.contains(&k)
            && !index
                .knowledge
                .artifacts
                .iter()
                .any(|a| a.profile.relation_types.iter().any(|t| t.name == k))
        {
            return Err(SectError::Other(format!(
                "unknown --type `{k}`; one of {}",
                EDGE_TYPES.join(", ")
            )));
        }
    }
    let id = id.trim();
    let (work, _) = sect_core::split_expr(id);
    let known = index.tree.get(work).is_some()
        || index.graph.action(id).is_some()
        || !index.graph.actions_of(id).is_empty();
    if !known {
        return Err(SectError::NotFound(id.to_string()));
    }
    let hits: Vec<RefHit> = sect_struct::refs(
        &index.tree,
        &index.graph,
        id,
        direction,
        kind,
        depth,
        Some(as_of.unwrap_or_else(|| index.snapshot_date())),
        include_superseded,
    );
    let entries: Vec<RefEntry> = hits
        .into_iter()
        .map(|h| RefEntry {
            depth: h.depth,
            other_title: title_of(index, &h.other),
            other: h.other,
            edge: h.edge,
        })
        .collect();
    let (knowledge, knowledge_truncated) =
        knowledge_refs::traverse(index, id, direction, kind, depth, include_superseded);
    let n = entries.len() + knowledge.len();
    let result = RefsResult {
        knowledge,
        knowledge_truncated,
        id: id.to_string(),
        direction,
        kind: kind.map(str::to_string),
        depth: depth.max(1),
        as_of,
        include_superseded,
        hits: entries,
    };
    Ok(Response {
        header: header(index, n, n, vec![]),
        result,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageEntry {
    pub id: String,
    pub label: String,
    pub title: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DefineResult {
    pub concepts: Vec<ConceptMatch>,
    pub term: String,
    pub slug: String,
    pub defined: bool,
    pub ambiguous: bool,
    pub occurrences: Vec<sect_struct::TermRec>,
    pub id: Option<String>,
    pub expr: Option<String>,
    pub anchor: Option<String>,
    pub breadcrumb: Option<String>,
    pub line: Option<usize>,
    pub definition: Option<String>,
    pub as_of: Option<NaiveDate>,
    pub scope: Option<String>,
    pub usages: Vec<UsageEntry>,
    /// When the term is not defined: defined terms sharing a word with the query.
    pub nearest: Vec<String>,
}

/// `sect define <term> [--usages] [--scope id] [--as-of DATE]`: defined-term lookup by
/// structural resolution over `terms.json`.
pub fn define(
    index: &Index,
    term: &str,
    usages: bool,
    scope: Option<&str>,
    as_of: Option<NaiveDate>,
) -> Result<Response<DefineResult>> {
    let snapshot = index.at(as_of.unwrap_or_else(|| index.snapshot_date()));
    let index = &snapshot;
    if let Some(s) = scope {
        if index.tree.get(s).is_none() {
            return Err(SectError::NotFound(s.to_string()));
        }
    }
    let slug = sect_corpus::slug(term);
    let occurrences = index.graph.definitions(term, &index.tree, scope, as_of);
    let rec = if occurrences.len() == 1 {
        occurrences
            .first()
            .copied()
            .filter(|r| !r.definition.trim().is_empty() && r.line > 0)
    } else {
        None
    };
    let active = match (rec, as_of) {
        (Some(r), Some(d)) => index.tree.work_active_at(&r.id, d),
        _ => true,
    };
    let words: Vec<String> = term
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let nearest: Vec<String> = if rec.is_none() || !active {
        index
            .graph
            .terms
            .values()
            .filter(|r| {
                words
                    .iter()
                    .any(|w| r.term.to_lowercase().split_whitespace().any(|x| x == w))
            })
            .map(|r| r.term.clone())
            .take(8)
            .collect()
    } else {
        vec![]
    };
    let mut result = DefineResult {
        concepts: concepts::lookup(index, term, scope),
        term: term.to_string(),
        slug: slug.clone(),
        defined: false,
        ambiguous: occurrences.len() > 1,
        occurrences: occurrences.into_iter().cloned().collect(),
        id: None,
        expr: None,
        anchor: None,
        breadcrumb: None,
        line: None,
        definition: None,
        as_of,
        scope: scope.map(str::to_string),
        usages: vec![],
        nearest,
    };
    if let (Some(r), true) = (rec, active) {
        result.defined = true;
        result.id = Some(r.id.clone());
        result.expr = Some(r.expr.clone());
        result.anchor = Some(r.anchor.clone());
        result.breadcrumb = index.tree.get(&r.id).map(|n| n.breadcrumb.clone());
        result.line = Some(r.line);
        result.definition = Some(r.definition.clone());
        if usages {
            let filtered: Vec<&Usage> = r
                .usages
                .iter()
                .filter(|u| scope.map(|s| index.tree.within(&u.id, s)).unwrap_or(true))
                .filter(|u| {
                    index
                        .tree
                        .get(&u.id)
                        .map(|n| n.current == u.expr)
                        .unwrap_or(false)
                })
                .collect();
            result.usages = filtered
                .into_iter()
                .map(|u| {
                    let n = index.tree.get(&u.id);
                    UsageEntry {
                        id: u.id.clone(),
                        label: n.map(|n| n.label.clone()).unwrap_or_default(),
                        title: n.map(|n| n.title.clone()).unwrap_or_default(),
                        count: u.count,
                    }
                })
                .collect();
        }
    }
    if !result.defined && result.occurrences.is_empty() {
        result.ambiguous = result.concepts.len() > 1;
        if let [matched] = result.concepts.as_slice() {
            if let Some(definition) = matched
                .concept
                .definition
                .as_ref()
                .filter(|d| !d.trim().is_empty())
            {
                result.defined = true;
                result.definition = Some(definition.clone());
                if let Some(m) = matched.mentions.first() {
                    result.expr = Some(m.at.revision.clone());
                    result.id = Some(sect_core::split_expr(&m.at.revision).0.into());
                    result.anchor = m.at.anchor.clone();
                }
            }
        }
    }
    let shown = if result.defined {
        1 + result.usages.len()
    } else {
        0
    };
    Ok(Response {
        header: header(index, shown, shown, vec![]),
        result,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// BM25 top-100 + vector top-100 fused with RRF (the default).
    Fuse,
    /// Lexical only.
    Fts,
    /// Vector only.
    Vector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Expand {
    /// One-line summaries of every section each hit references (depth 1).
    Refs,
    /// The ancestor chain of each hit.
    Ancestors,
}

impl Expand {
    pub fn parse(s: &str) -> Option<Expand> {
        match s {
            "refs" => Some(Expand::Refs),
            "ancestors" => Some(Expand::Ancestors),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub evidence_budget: usize,
    pub legacy_snippets: bool,
    /// Evaluation ablation: body BM25 or plain hybrid disables Sect pins/signals/relations.
    pub baseline: Option<String>,
    pub relations: RelationMode,
    pub relation_types: Vec<String>,
    pub explain: bool,
    pub query: String,
    pub mode: SearchMode,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub as_of: Option<NaiveDate>,
    pub include_superseded: bool,
    pub limit: usize,
    pub expand: Option<Expand>,
    /// `--seed`: a lexical-heavy top-k rendered as a compact context block under `budget` tokens.
    pub seed: bool,
    pub budget: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Expanded {
    pub id: String,
    pub label: String,
    pub title: String,
    pub anchor: Option<String>,
    pub effective: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub evidence: Option<evidence::EvidencePacket>,
    pub role: String,
    pub retrieval_path: Option<RetrievalPath>,
    pub rank: usize,
    pub id: String,
    pub expr: String,
    pub anchor: Option<String>,
    pub label: String,
    pub title: String,
    pub breadcrumb: String,
    pub kind: String,
    pub source: String,
    pub effective: Option<NaiveDate>,
    /// RRF score normalized so that rank 1 in both lists is 1.0, plus the signal table.
    pub score: f64,
    /// Set when the hit was placed by a structural rule rather than ranking.
    pub pinned: Option<String>,
    pub lex_rank: Option<usize>,
    pub vec_rank: Option<usize>,
    pub cosine: Option<f32>,
    pub chunk_id: String,
    pub part: usize,
    pub nparts: usize,
    /// Best matching body line (1-based) and its text.
    pub line: Option<usize>,
    pub snippet: String,
    pub overridden_by: Vec<String>,
    pub narrowed_by: Vec<Narrow>,
    pub refs_in: usize,
    pub refs_out: usize,
    pub expanded: Vec<Expanded>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeedBlock {
    pub budget: usize,
    pub tokens: usize,
    pub entries: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Confidence {
    /// Fraction of the query's content terms present in the top hit's chunk.
    pub lex_overlap: f64,
    pub cosine: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SupportingContext {
    pub expr: String,
    pub anchor: Option<String>,
    pub title: String,
    pub body: String,
    pub path: RetrievalPath,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub response_version: u32,
    pub evidence_word_budget: usize,
    pub legacy_snippets: bool,
    pub baseline: Option<String>,
    pub supporting_context: Vec<SupportingContext>,
    pub context_truncated: bool,
    pub context_word_budget: usize,
    pub relations: RelationMode,
    pub traversal: TraversalReport,
    pub query: String,
    pub mode: SearchMode,
    pub expand: Option<Expand>,
    pub seed: Option<SeedBlock>,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub as_of: Option<NaiveDate>,
    pub include_superseded: bool,
    pub limit: usize,
    /// The query looked like an id or a defined term, so BM25 was weighted x2.
    pub id_or_term_like: bool,
    pub weights: (f64, f64),
    pub candidates_lexical: usize,
    pub candidates_vector: usize,
    pub embedding: Option<String>,
    /// Nothing cleared the confidence floor: the hits are nearest candidates, not an answer.
    pub abstained: bool,
    pub nearest: Option<String>,
    pub confidence: Confidence,
    pub hits: Vec<SearchHit>,
}

fn best_line(body: &str, terms: &[String], line_start: usize) -> (Option<usize>, String) {
    let mut best: Option<(usize, usize, &str)> = None;
    for (i, line) in body.lines().enumerate() {
        let low = line.to_lowercase();
        let score = terms.iter().filter(|t| low.contains(t.as_str())).count();
        if score > 0 && best.map(|b| score > b.0).unwrap_or(true) {
            best = Some((score, i, line));
        }
    }
    match best {
        Some((_, i, line)) => {
            let mut text = line.trim().to_string();
            if text.chars().count() > 220 {
                text = text.chars().take(217).collect::<String>() + "...";
            }
            (Some(line_start + i), text)
        }
        None => {
            let first = body
                .lines()
                .find(|l| !l.trim().is_empty() && !l.starts_with('#'))
                .unwrap_or("")
                .trim();
            (None, first.chars().take(220).collect())
        }
    }
}

fn norm_words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '-'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The longest defined term whose words appear as a phrase in the query (last word may be plural).
fn find_term<'a>(
    index: &'a Index,
    query: &str,
    scope: Option<&str>,
) -> Option<(&'a sect_struct::TermRec, usize)> {
    let q = norm_words(query);
    let mut best: Option<(&sect_struct::TermRec, usize)> = None;
    for rec in index.graph.terms.values() {
        let t = norm_words(&rec.term);
        if t.is_empty() || t.len() > q.len() {
            continue;
        }
        let found = q.windows(t.len()).any(|w| {
            w.iter().zip(t.iter()).enumerate().all(|(i, (a, b))| {
                a == b || (i == t.len() - 1 && a.strip_suffix('s') == Some(b.as_str()))
            })
        });
        if found {
            let resolved = index.graph.definitions(&rec.term, &index.tree, scope, None);
            if resolved.len() != 1
                || resolved[0].expr != rec.expr
                || rec.definition.is_empty()
                || rec.line == 0
            {
                continue;
            }
        }
        if found
            && best
                .map(|(b, _)| {
                    t.len() > norm_words(&b.term).len()
                        || (t.len() == norm_words(&b.term).len() && rec.term.len() > b.term.len())
                })
                .unwrap_or(true)
        {
            best = Some((rec, t.len()));
        }
    }
    best
}

static DEFINE_CUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?:defin\w*\s+of|definition\s+of|meaning\s+of|what\s+is|what\s+are|what\s+does|who\s+is|what\s+counts\s+as|define|term)\s+(?:a\s+|an\s+|the\s+)?(?P<t1>.+)$|^(?P<t2>.+?)s?\s+(?:definition|meaning|means|defined|vs|versus)\b").unwrap()
});

/// A define-shaped query: a cue word right next to the defined term ("what is a hole",
/// "toeboard definition"), so a long question that merely mentions a term is not one.
fn define_shaped(query: &str, term: &str) -> bool {
    let q = norm_words(query).join(" ");
    let t = norm_words(term).join(" ");
    let Some(c) = DEFINE_CUE.captures(&q) else {
        return false;
    };
    let tail = c
        .name("t1")
        .or_else(|| c.name("t2"))
        .map(|m| m.as_str())
        .unwrap_or("");
    tail == t
        || tail == format!("{t}s")
        || tail.starts_with(&format!("{t} "))
        || tail.starts_with(&format!("{t}s "))
}

/// `sect search`: hybrid retrieval (spec B.4) with the signal table. Structural guarantees never
/// come from here; the pins are direct lookups, not scores.
pub fn search(index: &Index, opts: &SearchOptions) -> Result<Response<SearchResult>> {
    if opts
        .baseline
        .as_deref()
        .is_some_and(|b| !matches!(b, "body-bm25" | "plain-hybrid"))
    {
        return Err(SectError::Other(
            "baseline must be body-bm25 or plain-hybrid".into(),
        ));
    }
    let mut effective_options = opts.clone();
    if let Some(baseline) = &opts.baseline {
        effective_options.mode = if baseline == "body-bm25" {
            SearchMode::Fts
        } else {
            SearchMode::Fuse
        };
        effective_options.relations = RelationMode::Off;
    }
    let opts = &effective_options;
    let date = opts.as_of.unwrap_or_else(|| index.snapshot_date());
    let snapshot = index.at(date);
    let index = &snapshot;
    let limit = opts.limit.clamp(1, 50);
    if let Some(s) = &opts.scope {
        if index.tree.get(s).is_none() {
            return Err(SectError::NotFound(s.clone()));
        }
    }
    // The required model and passage view are independent immutable reads. Retain a
    // semantic-load error until the semantic leg so lexical/error precedence stays intact.
    let (state, semantic_resources) = rayon::join(
        || index.search_state(),
        || -> Result<_> {
            if opts.mode != SearchMode::Fts && index.has_semantic() {
                Ok(Some((index.vectors()?, index.embedder()?)))
            } else {
                Ok(None)
            }
        },
    );
    let state = state?;
    let chunks = &state.chunks;
    let selected = state.selection(
        index,
        sect_index::search_state::SelectionKey {
            date,
            scope: opts.scope.clone(),
            source: opts.source.clone(),
            kind: opts.kind.clone(),
            include_superseded: opts.include_superseded,
        },
    )?;
    let allowed_exprs = &selected.expressions;
    let by_chunk = &state.by_chunk;
    let lx = index.lexical()?;
    let qterms = lx.text_terms(&opts.query);

    // Pins: citation short-circuit and definition resolution (direct lookups, rank 1).
    let resolver = sect_corpus::Resolver::new(&index.sources);
    let mut pins: Vec<(String, Option<String>, String)> = Vec::new();
    let (direct, direct_anchor) = sect_core::split_anchor(opts.query.trim());
    let (direct_work, direct_date) = sect_core::split_expr(direct);
    let direct_citation = index
        .tree
        .get(direct_work)
        .map(|_| sect_corpus::cite::Citation {
            id: direct_work.into(),
            anchor: direct_anchor.map(str::to_string),
            offset: 0,
            text: opts.query.clone(),
        });
    let citation = direct_citation
        .or_else(|| resolver.resolve(&opts.query))
        .filter(|c| index.tree.get(&c.id).is_some());
    if let Some(c) = &citation {
        let expr = if direct_date.is_some() && c.id == direct_work {
            Some(direct.to_string())
        } else {
            match opts.as_of {
                Some(d) => index.tree.as_of(&c.id, d).map(|e| e.expr.clone()),
                None => index.tree.get(&c.id).map(|n| n.current.clone()),
            }
        };
        if let Some(e) = expr.filter(|e| allowed_exprs.contains(e)) {
            let anchor = c.anchor.clone().filter(|a| {
                index
                    .tree
                    .get(&c.id)
                    .map(|n| n.anchors.contains(a))
                    .unwrap_or(false)
            });
            pins.push((e, anchor, "citation short-circuit".into()));
        }
    }
    let term_hit = find_term(index, &opts.query, opts.scope.as_deref());
    if let Some((rec, _)) = term_hit {
        if define_shaped(&opts.query, &rec.term) {
            let expr = match opts.as_of {
                Some(d) => index.tree.as_of(&rec.id, d).map(|e| e.expr.clone()),
                None => Some(rec.expr.clone()),
            };
            if let Some(e) = expr.filter(|e| allowed_exprs.contains(e)) {
                pins.push((
                    e,
                    Some(rec.anchor.clone()),
                    format!("definition resolution: {}", rec.term),
                ));
            }
        }
    }
    let cites = sect_lexical::cite_tokens(&opts.query);
    let term_like = term_hit
        .map(|(_, words)| sect_rank::term_like(qterms.len(), words))
        .unwrap_or(false);
    let id_or_term_like = citation.is_some() || !cites.is_empty() || term_like;
    let weights = if opts.baseline.is_some() {
        pins.clear();
        (1.0, 1.0)
    } else {
        sect_rank::weights(id_or_term_like, opts.seed)
    };

    // The two legs.
    let mut lex_ids: Vec<String> = Vec::new();
    let mut vec_ids: Vec<String> = Vec::new();
    let mut cos_of: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
    let mut embedding = None;
    if opts.mode != SearchMode::Vector {
        lex_ids = lx
            .search_selected(
                &opts.query,
                &sect_lexical::SelectedFilter {
                    source: opts.source.as_deref(),
                    kind: opts.kind.as_deref(),
                    expressions: if selected.all_expressions {
                        sect_lexical::ExpressionFilter::AllIndexed
                    } else {
                        sect_lexical::ExpressionFilter::Only(allowed_exprs)
                    },
                },
                sect_lexical::CANDIDATES,
                opts.baseline.as_deref() == Some("body-bm25"),
            )?
            .into_iter()
            .filter(|h| by_chunk.contains_key(h.chunk_id.as_str()))
            .map(|h| chunks[by_chunk[h.chunk_id.as_str()]].chunk_id.clone())
            .collect();
        let mut seen = std::collections::HashSet::new();
        lex_ids.retain(|id| seen.insert(id.clone()));
    }
    if opts.mode != SearchMode::Fts {
        if let Some((vectors, embedder)) = semantic_resources? {
            embedding = Some(vectors.model.clone());
            let q = embedder.embed(std::slice::from_ref(&opts.query))?.remove(0);
            for (i, cos) in vectors.search(
                &q,
                sect_semantic::CANDIDATES,
                selected.vector_rows(&vectors, &state),
            ) {
                vec_ids.push(vectors.ids[i].clone());
                cos_of.insert(vectors.ids[i].clone(), cos);
            }
        } else if opts.mode == SearchMode::Vector {
            return Err(SectError::Other("the semantic layer is not built (indexed with --embedding none); use --fts or rebuild the index".into()));
        }
    }
    let snippet_terms: Vec<String> = if qterms.is_empty() {
        opts.query
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .collect()
    } else {
        qterms.clone()
    };

    // Fusion, then the signal table.
    let mut fused = sect_rank::fuse(&lex_ids, &vec_ids, weights, sect_rank::RRF_K);
    let connected = connected::expand(
        index,
        &state,
        allowed_exprs,
        opts,
        if opts.baseline.is_some() {
            RelationMode::Off
        } else {
            opts.relations
        },
        &opts.relation_types,
        &mut fused,
    );
    let refs_in = &state.refs_in;
    let per_work: std::collections::HashMap<&str, usize> = fused
        .iter()
        .filter_map(|f| by_chunk.get(f.chunk_id.as_str()))
        .fold(std::collections::HashMap::new(), |mut m, i| {
            *m.entry(chunks[*i].id.as_str()).or_default() += 1;
            m
        });
    let qset: std::collections::HashSet<&String> = qterms.iter().collect();
    let scored: Vec<sect_rank::Fused> = fused
        .into_iter()
        .map(|mut f| {
            if opts.baseline.is_some() {
                return f;
            }
            if let Some(&i) = by_chunk.get(f.chunk_id.as_str()) {
                let c = &chunks[i];
                let tp_terms = lx.text_terms(&format!("{} {} {}", c.label, c.title, c.breadcrumb));
                let matched = tp_terms.iter().filter(|t| qset.contains(t)).count();
                let s = sect_rank::Signals {
                    title_path_fraction: if qset.is_empty() {
                        0.0
                    } else {
                        matched as f64 / qset.len() as f64
                    },
                    refs_in: if c.recipe.is_empty() {
                        refs_in.get(c.id.as_str()).copied().unwrap_or(0)
                    } else {
                        0
                    },
                    is_note: c.kind == "note",
                    superseded: opts.include_superseded && c.superseded,
                    chunks_in_section: per_work.get(c.id.as_str()).copied().unwrap_or(1),
                };
                f.score = sect_rank::apply_signals(f.score, &s);
            }
            f
        })
        .collect();
    // One hit per section. With --include-superseded every Expression is its own section so an
    // older text can appear next to the current one, carrying the -0.5 penalty.
    let per_expr = opts.include_superseded;
    let mut collapsed = sect_rank::collapse(scored, |chunk_id| {
        by_chunk
            .get(chunk_id)
            .map(|i| {
                if chunks[*i].source_document && chunks[*i].nparts > 1 {
                    chunks[*i].chunk_id.clone()
                } else if per_expr {
                    chunks[*i].expr.clone()
                } else {
                    chunks[*i].id.clone()
                }
            })
            .unwrap_or_else(|| chunk_id.to_string())
    });
    // Pins go first, replacing any ranked entry for the same section.
    let mut pin_info: std::collections::HashMap<String, (Option<String>, String)> =
        std::collections::HashMap::new();
    for (expr, anchor, reason) in pins.iter().rev() {
        collapsed.retain(|f| {
            by_chunk
                .get(f.chunk_id.as_str())
                .map(|i| !chunks[*i].has_expression(expr))
                .unwrap_or(true)
        });
        let chunk_id = state
            .first_chunk_by_expr
            .get(expr)
            .map(|&i| &chunks[i])
            .map(|c| c.chunk_id.clone())
            .unwrap_or_else(|| format!("{expr}#c0"));
        collapsed.insert(
            0,
            sect_rank::Fused {
                chunk_id,
                score: 2.0,
                lex_rank: None,
                vec_rank: None,
            },
        );
        pin_info.insert(expr.clone(), (anchor.clone(), reason.clone()));
    }
    let matched = collapsed.len();

    let mut hits = Vec::new();
    for (rank, f) in collapsed.iter().take(limit).enumerate() {
        let Some(&ci) = by_chunk.get(f.chunk_id.as_str()) else {
            continue;
        };
        let c = &chunks[ci];
        let picked = c
            .spans
            .iter()
            .filter(|s| allowed_exprs.contains(&s.expr))
            .max_by_key(|s| {
                let text = format!("{} {}", s.title, &c.body[s.passage_start..s.passage_end])
                    .to_lowercase();
                (
                    pin_info.contains_key(&s.expr),
                    snippet_terms
                        .iter()
                        .filter(|t| text.contains(t.as_str()))
                        .count(),
                )
            });
        let hit_expr = picked.map(|s| s.expr.as_str()).unwrap_or(&c.expr);
        let hit_id = sect_core::split_expr(hit_expr).0;
        let node = index.tree.get(hit_id);
        let (line, snippet) = best_line(
            picked
                .map(|s| &c.body[s.passage_start..s.passage_end])
                .unwrap_or(&c.body),
            &snippet_terms,
            picked.map(|s| s.line_start).unwrap_or(c.line_start),
        );
        let refs_out = index
            .graph
            .edges
            .iter()
            .filter(|e| e.from == hit_id && e.kind == "references")
            .count();
        let (anchor, pinned) = pin_info
            .get(hit_expr)
            .map(|(a, r)| (a.clone(), Some(r.clone())))
            .unwrap_or((None, None));
        let date = opts
            .as_of
            .or(if opts.include_superseded {
                c.effective
            } else {
                None
            })
            .unwrap_or_else(|| chrono::Utc::now().date_naive());
        let expanded_revision = |id: &str, anchor: Option<String>| {
            let e = index
                .tree
                .as_of(id, date)
                .filter(|e| allowed_exprs.contains(&e.expr))?;
            let n = index.tree.get(id)?;
            Some(Expanded {
                id: id.into(),
                label: n.label.clone(),
                title: e.front.title.clone().unwrap_or_default(),
                anchor,
                effective: e.effective,
            })
        };
        let expanded = match opts.expand {
            Some(Expand::Refs) => {
                let mut seen = std::collections::HashSet::new();
                index
                    .graph
                    .edges
                    .iter()
                    .filter(|e| e.from_expr == hit_expr && e.kind == "references" && e.resolved)
                    .filter(|e| seen.insert(e.to.clone()))
                    .filter_map(|e| expanded_revision(&e.to, e.anchor.clone()))
                    .collect()
            }
            Some(Expand::Ancestors) => {
                let mut result = Vec::new();
                let mut parent = node
                    .and_then(|n| n.expressions.iter().find(|e| e.expr == hit_expr))
                    .and_then(|e| e.front.parent.clone());
                let mut seen = std::collections::HashSet::new();
                while let Some(id) = parent.take() {
                    if !seen.insert(id.clone()) {
                        break;
                    }
                    let Some(e) = index.tree.as_of(&id, date) else {
                        break;
                    };
                    parent = e.front.parent.clone();
                    if let Some(expanded) = expanded_revision(&id, None) {
                        result.push(expanded);
                    }
                }
                result.reverse();
                result
            }
            None => vec![],
        };
        hits.push(SearchHit {
            evidence: None,
            role: if c.navigation {
                "navigation"
            } else if f.lex_rank.is_some() || f.vec_rank.is_some() || pinned.is_some() {
                "primary"
            } else {
                "supporting"
            }
            .into(),
            retrieval_path: if opts.explain {
                connected.paths.get(&c.chunk_id).cloned()
            } else {
                None
            },
            rank: rank + 1,
            id: hit_id.into(),
            expr: hit_expr.into(),
            anchor,
            label: node
                .map(|n| n.label.clone())
                .unwrap_or_else(|| c.label.clone()),
            title: picked
                .map(|s| s.title.clone())
                .unwrap_or_else(|| c.title.clone()),
            breadcrumb: picked
                .map(|s| s.breadcrumb.clone())
                .unwrap_or_else(|| c.breadcrumb.clone()),
            kind: c.kind.clone(),
            source: c.source.clone(),
            effective: c.effective,
            score: (f.score * 10_000.0).round() / 10_000.0,
            pinned,
            lex_rank: f.lex_rank,
            vec_rank: f.vec_rank,
            cosine: cos_of.get(&c.chunk_id).copied(),
            chunk_id: c.chunk_id.clone(),
            part: c.part,
            nparts: c.nparts,
            line,
            snippet,
            overridden_by: node.map(|n| n.overridden_by.clone()).unwrap_or_default(),
            narrowed_by: node.map(|n| n.narrowed_by.clone()).unwrap_or_default(),
            refs_in: refs_in.get(c.id.as_str()).copied().unwrap_or(0),
            refs_out,
            expanded,
        });
    }

    evidence::assemble(
        index,
        &state,
        &mut hits,
        allowed_exprs,
        &snippet_terms,
        opts,
    );

    // Abstention: only when no structural pin answered.
    let mut confidence = Confidence {
        lex_overlap: 0.0,
        cosine: None,
    };
    let mut abstained = hits.is_empty();
    let mut nearest = None;
    if pins.is_empty() {
        if let Some(top) = hits.first() {
            let idx = by_chunk[top.chunk_id.as_str()];
            let c = &chunks[idx];
            let selected_text = c.spans.iter().find(|s| s.expr == top.expr).map(|s| {
                format!(
                    "{}\n{}",
                    s.breadcrumb,
                    &c.body[s.passage_start..s.passage_end]
                )
            });
            let selected_text = match selected_text {
                Some(text) => text,
                None => c.legacy_text(&index.dir().join(sect_index::CHUNKS))?,
            };
            let chunk_terms: std::collections::HashSet<String> =
                lx.text_terms(&selected_text).into_iter().collect();
            confidence.lex_overlap = if qset.is_empty() {
                0.0
            } else {
                qterms.iter().filter(|t| chunk_terms.contains(*t)).count() as f64
                    / qterms.len() as f64
            };
            confidence.cosine = if opts.mode == SearchMode::Fts {
                None
            } else {
                top.cosine
            };
            abstained = sect_rank::should_abstain(confidence.lex_overlap, confidence.cosine);
        }
        if abstained {
            nearest = Some(
                hits.first()
                    .map(|h| h.breadcrumb.clone())
                    .or_else(|| {
                        opts.scope
                            .as_ref()
                            .and_then(|s| index.tree.get(s))
                            .map(|n| n.breadcrumb.clone())
                    })
                    .unwrap_or_else(|| "corpus root".into()),
            );
        }
    }

    // Seed block: a compact, lexical-heavy context block under a token budget.
    let seed = if opts.seed {
        let budget = opts.budget.max(50);
        let mut tokens = 0usize;
        let mut lines = Vec::new();
        for h in &hits {
            let flags = if h.overridden_by.is_empty() && h.narrowed_by.is_empty() {
                String::new()
            } else {
                format!(
                    " | {}{}",
                    if h.overridden_by.is_empty() {
                        String::new()
                    } else {
                        format!("overridden-by {}", h.overridden_by.join(","))
                    },
                    if h.narrowed_by.is_empty() {
                        String::new()
                    } else {
                        format!(
                            " narrowed-by {}",
                            h.narrowed_by
                                .iter()
                                .map(|n| n.id.clone())
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    }
                )
            };
            let head = format!(
                "- {} | {} {} | {} | eff {}{}",
                h.id,
                h.label,
                h.title,
                h.breadcrumb.rsplit(" > ").nth(1).unwrap_or(""),
                h.effective
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| "n/a".into()),
                flags
            );
            let snippet: String = h
                .snippet
                .split_whitespace()
                .take(40)
                .collect::<Vec<_>>()
                .join(" ");
            let entry_tokens = head.split_whitespace().count() + snippet.split_whitespace().count();
            if tokens + entry_tokens > budget {
                break;
            }
            tokens += entry_tokens;
            lines.push(format!("{head}\n  {snippet}"));
        }
        Some(SeedBlock {
            budget,
            tokens,
            entries: lines.len(),
            text: lines.join("\n"),
        })
    } else {
        None
    };

    // Graph context shares the aggregate evidence ceiling and never consumes a result slot.
    // `budget` remains an optional tighter cap for this legacy context field and seed output.
    let quoted_words: usize = hits
        .iter()
        .filter_map(|h| h.evidence.as_ref())
        .map(|p| p.words)
        .sum();
    let context_word_budget = opts.budget.min(
        opts.evidence_budget
            .min(20_000)
            .saturating_sub(quoted_words),
    );
    let mut context_words = 0;
    let mut context_truncated = false;
    let mut supporting_context = Vec::new();
    let displayed: std::collections::HashSet<&str> = hits.iter().map(|h| h.expr.as_str()).collect();
    let mut included = std::collections::HashSet::new();
    for ((_, expr, _), path) in &connected.required {
        if !displayed.contains(path.seed.as_str()) || displayed.contains(expr.as_str()) {
            continue;
        }
        let anchor = path.steps.last().and_then(|s| s.anchor.clone());
        if !included.insert((expr, anchor.clone())) {
            continue;
        }
        let target = format!(
            "{expr}{}",
            anchor.as_ref().map(|a| format!("#{a}")).unwrap_or_default()
        );
        let context = read(index, &target, &ReadOptions::default())?.result;
        let words = context.body.split_whitespace().count();
        if context_words + words > context_word_budget {
            context_truncated = true;
            continue;
        }
        context_words += words;
        supporting_context.push(SupportingContext {
            expr: expr.clone(),
            anchor,
            title: context.title,
            body: context.body,
            path: path.clone(),
        });
    }
    let shown = hits.len();
    let mut extra = vec![
        ("candidates-lexical".to_string(), lex_ids.len()),
        ("candidates-vector".to_string(), vec_ids.len()),
        ("limit".to_string(), limit),
    ];
    if abstained {
        extra.push(("abstained".to_string(), 1));
    }
    let result = SearchResult {
        response_version: 2,
        evidence_word_budget: opts.evidence_budget.min(20_000),
        legacy_snippets: opts.legacy_snippets,
        baseline: opts.baseline.clone(),
        supporting_context,
        context_truncated,
        context_word_budget,
        relations: opts.relations,
        traversal: connected.report,
        query: opts.query.clone(),
        mode: opts.mode,
        expand: opts.expand,
        seed,
        scope: opts.scope.clone(),
        source: opts.source.clone(),
        kind: opts.kind.clone(),
        as_of: opts.as_of,
        include_superseded: opts.include_superseded,
        limit,
        id_or_term_like,
        weights,
        candidates_lexical: lex_ids.len(),
        candidates_vector: vec_ids.len(),
        embedding,
        abstained,
        nearest,
        confidence,
        hits,
    };
    Ok(Response {
        header: header(index, shown, matched, extra),
        result,
    })
}

/// Where a matched line sits in the corpus: the Work, the Expression, and the nearest paragraph.
#[derive(Debug, Clone, Serialize)]
pub struct Annotation {
    pub id: String,
    pub expr: String,
    pub anchor: Option<String>,
    pub label: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrepLineOut {
    pub path: String,
    pub line: u64,
    pub kind: sect_exact::LineKind,
    pub text: String,
    pub break_before: bool,
    pub annotation: Option<Annotation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrepResult {
    pub patterns: Vec<String>,
    /// lines | counts | files | per-file-counts
    pub mode: String,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub lines: Vec<GrepLineOut>,
    pub per_file: Vec<sect_exact::FileCount>,
    pub files_searched: usize,
    pub files_matched: usize,
    pub total_matches: usize,
    pub truncated: bool,
    pub max_hits: usize,
    /// Set when the answer was bounded: what to do next.
    pub note: Option<String>,
    /// What the n-gram prefilter did (absent when the layer is off or --no-index was given).
    pub prefilter: Option<sect_ngram::Plan>,
    /// Time in the matcher scan, after the prefilter.
    pub scan_ms: f64,
}

/// `sect grep`: exhaustive exact/regex search, ripgrep-compatible, bounded by `--max-hits`.
/// `--annotate` names the section and paragraph of every line; `--scope` limits the files to a
/// subtree and `--source` to one source.
pub fn grep(
    index: &Index,
    opts: &sect_exact::GrepOptions,
    annotate: bool,
    scope: Option<&str>,
    source: Option<&str>,
    no_index: bool,
) -> Result<Response<GrepResult>> {
    let mut opts = opts.clone();
    if scope.is_some() || source.is_some() {
        if let Some(s) = scope {
            if index.tree.get(s).is_none() {
                return Err(SectError::NotFound(s.to_string()));
            }
        }
        let mut allowed: Vec<String> = Vec::new();
        for n in index.tree.nodes.values() {
            let ok_scope = scope.map(|s| index.tree.within(&n.id, s)).unwrap_or(true);
            let ok_source = source.map(|s| n.source == s).unwrap_or(true);
            if ok_scope && ok_source {
                allowed.extend(n.expressions.iter().map(|e| e.path.clone()));
            }
        }
        opts.only_paths = Some(allowed);
    }
    // The prefilter narrows the files the matcher must read; it never decides a match, and it
    // is not consulted when the index may be stale (a file added since the build would be missing
    // from its list).
    let mut prefilter: Option<sect_ngram::Plan> = None;
    if !no_index && index.freshness.is_fresh() {
        if let Some(pf) = index.prefilter() {
            let plan = pf.plan(&opts.patterns, opts.fixed_strings, opts.ignore_case);
            if let Some(c) = &plan.candidates {
                // The candidates are the files to read, in walk order: no directory walk at all.
                // A scope or source restriction stays in `only_paths` and still applies.
                opts.files = Some(c.clone());
            }
            prefilter = Some(plan);
        }
    }
    let t_scan = std::time::Instant::now();
    let raw = index.grep(&opts)?;
    let scan_ms = t_scan.elapsed().as_secs_f64() * 1000.0;
    let mode = if raw.truncated {
        "per-file-counts"
    } else if opts.count || opts.count_only {
        "counts"
    } else if opts.files_with_matches {
        "files"
    } else {
        "lines"
    };
    let mut path_to_expr: BTreeMap<&str, (&Node, &sect_struct::ExprInfo)> = BTreeMap::new();
    if annotate {
        for n in index.tree.nodes.values() {
            for e in &n.expressions {
                path_to_expr.insert(e.path.as_str(), (n, e));
            }
        }
    }
    let mut offsets: BTreeMap<String, (usize, Vec<sect_corpus::AnchorLine>)> = BTreeMap::new();
    let mut lines = Vec::with_capacity(raw.lines.len());
    for l in raw.lines {
        let annotation = if annotate {
            path_to_expr.get(l.path.as_str()).map(|(n, e)| {
                let (offset, anchors) = offsets.entry(l.path.clone()).or_insert_with(|| {
                    let text = index.read_text(&l.path).unwrap_or_default();
                    let body = sect_corpus::split_front_matter(&text)
                        .map(|(_, b)| b)
                        .unwrap_or("");
                    let offset = text[..text.len() - body.len()].matches('\n').count();
                    (offset, paragraph_anchors(body))
                });
                let body_line = l.line as i64 - *offset as i64;
                let anchor = if body_line < 1 {
                    Some("front-matter".to_string())
                } else {
                    anchors
                        .iter()
                        .rfind(|a| a.line as i64 <= body_line)
                        .map(|a| a.anchor.clone())
                };
                Annotation {
                    id: n.id.clone(),
                    expr: e.expr.clone(),
                    anchor,
                    label: n.label.clone(),
                    title: n.title.clone(),
                }
            })
        } else {
            None
        };
        lines.push(GrepLineOut {
            path: l.path,
            line: l.line,
            kind: l.kind,
            text: l.text,
            break_before: l.break_before,
            annotation,
        });
    }
    let note = if raw.truncated {
        Some(format!("{} matching lines across {} files exceed --max-hits {}; per-file counts follow. Narrow the pattern, add -g, --scope, or --source, or raise --max-hits.", raw.total_matches, raw.files_matched, raw.max_hits))
    } else {
        None
    };
    // "shown" counts matching lines only; context lines are extra and never counted as matches.
    let shown = match mode {
        "lines" => lines
            .iter()
            .filter(|l| l.kind == sect_exact::LineKind::Match)
            .count(),
        _ => raw.per_file.len(),
    };
    let mut extra = vec![
        ("files-searched".to_string(), raw.files_searched),
        ("files-matched".to_string(), raw.files_matched),
        ("matching-lines".to_string(), raw.total_matches),
        ("max-hits".to_string(), raw.max_hits),
    ];
    if let Some(n) = prefilter.as_ref().and_then(|p| p.candidate_count) {
        extra.push(("candidates".to_string(), n));
    }
    if raw.truncated {
        extra.push(("over-max-hits".to_string(), 1));
    }
    let result = GrepResult {
        patterns: opts.patterns.clone(),
        mode: mode.to_string(),
        scope: scope.map(str::to_string),
        source: source.map(str::to_string),
        lines,
        per_file: raw.per_file,
        files_searched: raw.files_searched,
        files_matched: raw.files_matched,
        total_matches: raw.total_matches,
        truncated: raw.truncated,
        max_hits: raw.max_hits,
        note,
        prefilter,
        scan_ms,
    };
    Ok(Response {
        header: header(index, shown, raw.total_matches, extra),
        result,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResult {
    pub creation_coverage: BTreeMap<String, serde_json::Value>,
    pub generation: String,
    pub knowledge_profiles: Vec<String>,
    pub relations_accepted: usize,
    pub concepts_accepted: usize,
    pub evidence_states: BTreeMap<String, usize>,
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
    pub edges: usize,
    pub actions: usize,
    pub terms: usize,
    pub tables: usize,
    pub chunks: usize,
    pub embedding: Option<String>,
    pub warnings: Vec<Issue>,
    pub unresolved: Vec<Edge>,
    pub unresolved_refs: usize,
    pub build_ms: u128,
}

/// `sect status`: freshness, counts, warnings, unresolved refs, legal-status summary (spec B.3).
pub fn status(index: &Index) -> Result<Response<StatusResult>> {
    let m = &index.manifest;
    let mut legal: BTreeMap<String, usize> = BTreeMap::new();
    for n in index.tree.nodes.values() {
        *legal.entry(n.legal_status.clone()).or_default() += 1;
    }
    let mut evidence_states = BTreeMap::new();
    for n in index.tree.nodes.values().filter(|n| !n.current.is_empty()) {
        let checks = n
            .expressions
            .iter()
            .find(|e| e.expr == n.current)
            .and_then(|e| e.front.provenance.as_ref())
            .map(|p| &p.checks);
        if checks.map(|c| c.is_empty()).unwrap_or(true) {
            *evidence_states.entry("unchecked".into()).or_default() += 1;
        } else {
            for state in checks.unwrap().values() {
                *evidence_states
                    .entry(serde_json::to_value(state)?.as_str().unwrap().to_string())
                    .or_default() += 1;
            }
        }
    }
    let result = StatusResult {
        creation_coverage: index.regions()?.coverage.clone(),
        generation: m.generation.clone(),
        knowledge_profiles: index
            .knowledge
            .artifacts
            .iter()
            .map(|a| format!("{}@{}", a.profile.name, a.profile.version))
            .collect(),
        relations_accepted: index
            .knowledge
            .artifacts
            .iter()
            .flat_map(|a| &a.relations)
            .filter(|r| r.verification.state == sect_core::knowledge::CheckState::Passed)
            .count(),
        concepts_accepted: index
            .knowledge
            .artifacts
            .iter()
            .flat_map(|a| &a.concepts)
            .filter(|r| r.verification.state == sect_core::knowledge::CheckState::Passed)
            .count(),
        evidence_states,
        corpus_root: m.corpus_root.clone(),
        index_dir: index
            .root
            .join(sect_core::INDEX_DIR)
            .to_string_lossy()
            .replace('\\', "/"),
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
        edges: m.edges,
        actions: m.actions,
        terms: m.terms,
        tables: m.tables,
        chunks: m.chunks,
        embedding: m.embedding.clone(),
        warnings: m.warnings.clone(),
        unresolved: m.unresolved.clone(),
        unresolved_refs: m.unresolved_refs,
        build_ms: m.build_ms,
    };
    let extra = vec![
        ("warnings".to_string(), m.warnings.len()),
        ("unresolved-refs".to_string(), m.unresolved_refs),
    ];
    Ok(Response {
        header: header(index, m.works, m.works, extra),
        result,
    })
}
