//! Verbs (spec B.3). Every verb returns a [`Response`] whose header carries the freshness and
//! counts lines. Milestones 1-2: `read`, `map`, `refs`, `define`, `status`. Milestones 3-5 add
//! `grep` and `search`.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use sect_core::{split_anchor, Counts, Freshness, Header, Narrow, Response, Result, SectError};
use sect_corpus::document::paragraph_anchors;
use sect_corpus::Issue;
use sect_index::{Index, SourceSummary};
use sect_struct::{Direction, Edge, HistoryEntry, MapItem, Node, RefHit, TableRec, Usage, EDGE_TYPES};
use serde::Serialize;

fn header(index: &Index, shown: usize, matched: usize, extra: Vec<(String, usize)>) -> Header {
    let m = &index.manifest;
    Header {
        freshness: index.freshness.clone(),
        counts: Counts { shown, matched, works: m.works, expressions: m.expressions, superseded: m.superseded, sources: m.sources.len(), extra },
    }
}

fn not_found_as_of(index: &Index, work: &str, date: NaiveDate) -> SectError {
    let earliest = index.tree.get(work).and_then(|n| n.expressions.first()).map(|e| e.expr.clone());
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
        Brief { id: n.id.clone(), label: n.label.clone(), title: n.title.clone(), level: n.level.clone() }
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
}

fn overlay_note(index: &Index, overlay: &str) -> String {
    match index.tree.get(overlay) {
        Some(n) => format!("(effective {}): {}", n.effective.map(|d| d.to_string()).unwrap_or_else(|| "n/a".into()), n.title),
        None => String::new(),
    }
}

/// `sect read <id[#anchor]>`: the section text with its structural context, overlay markers
/// inline, and optionally its ancestors, children, tables, and history.
pub fn read(index: &Index, id: &str, opts: &ReadOptions) -> Result<Response<ReadResult>> {
    let (target, anchor) = split_anchor(id.trim());
    let (work, _) = sect_core::split_expr(target);
    let (node, expr) = if let Some(v) = &opts.version {
        index.tree.resolve(v).ok_or_else(|| SectError::NotFound(v.clone()))?
    } else if let Some(date) = opts.as_of {
        let node = index.tree.get(work).ok_or_else(|| SectError::NotFound(work.to_string()))?;
        let e = index.tree.as_of(work, date).ok_or_else(|| not_found_as_of(index, work, date))?;
        (node, e)
    } else {
        index.tree.resolve(target).ok_or_else(|| SectError::NotFound(target.to_string()))?
    };
    let raw = index.read_body(&expr.path)?;
    let anchor_lines = paragraph_anchors(&raw);
    let lines: Vec<&str> = raw.lines().collect();
    let (start, end) = match anchor {
        None => (1usize, lines.len()),
        Some(a) => {
            let pos = anchor_lines.iter().position(|x| x.anchor == a).ok_or_else(|| SectError::NotFound(format!("{}#{a} (anchors: {})", node.id, node.anchors.join(", "))))?;
            let depth = a.matches('-').count();
            let start = anchor_lines[pos].line;
            let end = anchor_lines[pos + 1..].iter().find(|x| x.anchor.matches('-').count() <= depth).map(|x| x.line - 1).unwrap_or(lines.len());
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
                    markers.push(Marker { kind: "narrowed-by".into(), overlay: n.id.clone(), anchor: Some(a.clone()), line: ln, text: text.clone() });
                    out.push(text);
                }
            }
        }
        out.push(line.to_string());
        if !banner_done && !node.overridden_by.is_empty() && (line.starts_with('#') || ln == end) {
            for o in &node.overridden_by {
                let text = format!("> overridden-by {o} {}", overlay_note(index, o));
                markers.push(Marker { kind: "overridden-by".into(), overlay: o.clone(), anchor: None, line: ln, text: text.clone() });
                out.push(text);
            }
            banner_done = true;
        }
    }
    if !banner_done && !node.overridden_by.is_empty() {
        for o in &node.overridden_by {
            let text = format!("> overridden-by {o} {}", overlay_note(index, o));
            markers.push(Marker { kind: "overridden-by".into(), overlay: o.clone(), anchor: None, line: 0, text: text.clone() });
            out.insert(0, text);
        }
    }
    let result = ReadResult {
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
        ancestors: if opts.ancestors { index.tree.ancestors(&node.id).into_iter().map(Brief::from).collect() } else { vec![] },
        children: if opts.children { index.tree.children(&node.id).into_iter().map(Brief::from).collect() } else { vec![] },
        history: if opts.history { sect_struct::history(&index.tree, &index.graph, &node.id) } else { vec![] },
        tables: if opts.tables { index.graph.tables_of(&expr.expr).into_iter().cloned().collect() } else { vec![] },
        markers,
        body: out.join("\n"),
    };
    Ok(Response { header: header(index, 1, 1, vec![]), result })
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

fn node_flags(n: &Node) -> Vec<String> {
    let mut flags = Vec::new();
    if !n.overridden_by.is_empty() {
        flags.push(format!("overridden-by {}", n.overridden_by.join(",")));
    }
    if !n.narrowed_by.is_empty() {
        flags.push(format!("narrowed-by {}", n.narrowed_by.iter().map(|x| format!("{}#{}", x.id, x.anchor.clone().unwrap_or_default())).collect::<Vec<_>>().join(",")));
    }
    if n.expressions.len() > 1 {
        flags.push(format!("{} expressions", n.expressions.len()));
    }
    flags
}

/// `sect map [--scope id[#anchor]] [--depth n] [--budget tokens] [--complete]`: table of contents
/// bounded by a token budget, or the full subtree by traversal with `--complete`.
pub fn map(index: &Index, scope: Option<&str>, depth: usize, budget: usize, complete: bool) -> Result<Response<MapResult>> {
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
        let s = scope.ok_or_else(|| SectError::Other("map --complete needs --scope <id[#anchor]>".into()))?;
        let items = sect_struct::map_complete(&index.tree, s);
        total = items.len();
        for item in items {
            entries.push(match item {
                MapItem::Section { id, label, title, level, depth, children } => {
                    let n = index.tree.get(&id);
                    tokens += 2 + label.split_whitespace().count() + title.split_whitespace().count();
                    MapEntry { depth, kind: "section".into(), id, anchor: None, label, title, level, children, effective: n.and_then(|n| n.effective), flags: n.map(node_flags).unwrap_or_default() }
                }
                MapItem::Anchor { id, anchor, depth } => {
                    tokens += 1;
                    let n = index.tree.get(&id);
                    let narrowed = n.map(|n| n.narrowed_by.iter().filter(|x| x.anchor.as_deref() == Some(anchor.as_str())).map(|x| format!("narrowed-by {}", x.id)).collect()).unwrap_or_default();
                    MapEntry { depth, kind: "anchor".into(), id, anchor: Some(anchor), label: String::new(), title: String::new(), level: "paragraph".into(), children: 0, effective: None, flags: narrowed }
                }
            });
        }
    } else {
        let walked = index.tree.walk(scope, depth);
        total = walked.len();
        for (d, n) in walked {
            let line_tokens = 2 + n.label.split_whitespace().count() + n.title.split_whitespace().count();
            if tokens + line_tokens > budget {
                truncated = true;
                break;
            }
            tokens += line_tokens;
            entries.push(MapEntry { depth: d, kind: "section".into(), id: n.id.clone(), anchor: None, label: n.label.clone(), title: n.title.clone(), level: n.level.clone(), children: n.children.len(), effective: n.effective, flags: node_flags(n) });
        }
    }
    let shown = entries.len();
    let result = MapResult { scope: scope.map(str::to_string), complete, depth, budget, tokens, truncated, total, entries };
    Ok(Response { header: header(index, shown, total, vec![]), result })
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
        return index.graph.terms.get(t).map(|r| format!("term: {}", r.term)).unwrap_or_else(|| format!("term: {t}"));
    }
    if let Some(a) = index.graph.action(id) {
        return format!("{} {}{}", a.kind, a.target_id, a.target_anchor.as_ref().map(|x| format!("#{x}")).unwrap_or_default());
    }
    String::new()
}

/// `sect refs <id> [--direction in|out|both] [--type T] [--depth n] [--as-of DATE]`: the
/// blast-radius verb. Pure traversal over `xrefs.jsonl`.
pub fn refs(index: &Index, id: &str, direction: Direction, kind: Option<&str>, depth: usize, as_of: Option<NaiveDate>, include_superseded: bool) -> Result<Response<RefsResult>> {
    if let Some(k) = kind {
        if !EDGE_TYPES.contains(&k) {
            return Err(SectError::Other(format!("unknown --type `{k}`; one of {}", EDGE_TYPES.join(", "))));
        }
    }
    let id = id.trim();
    let (work, _) = sect_core::split_expr(id);
    let known = index.tree.get(work).is_some() || index.graph.action(id).is_some() || !index.graph.actions_of(id).is_empty();
    if !known {
        return Err(SectError::NotFound(id.to_string()));
    }
    let hits: Vec<RefHit> = sect_struct::refs(&index.tree, &index.graph, id, direction, kind, depth, as_of, include_superseded);
    let entries: Vec<RefEntry> = hits.into_iter().map(|h| RefEntry { depth: h.depth, other_title: title_of(index, &h.other), other: h.other, edge: h.edge }).collect();
    let n = entries.len();
    let result = RefsResult { id: id.to_string(), direction, kind: kind.map(str::to_string), depth: depth.clamp(1, 5), as_of, include_superseded, hits: entries };
    Ok(Response { header: header(index, n, n, vec![]), result })
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
    pub term: String,
    pub slug: String,
    pub defined: bool,
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
pub fn define(index: &Index, term: &str, usages: bool, scope: Option<&str>, as_of: Option<NaiveDate>) -> Result<Response<DefineResult>> {
    if let Some(s) = scope {
        if index.tree.get(s).is_none() {
            return Err(SectError::NotFound(s.to_string()));
        }
    }
    let slug = sect_corpus::slug(term);
    let rec = index.graph.terms.get(&slug);
    let active = match (rec, as_of) {
        (Some(r), Some(d)) => index.tree.work_active_at(&r.id, d),
        _ => true,
    };
    let words: Vec<String> = term.to_lowercase().split_whitespace().map(str::to_string).collect();
    let nearest: Vec<String> = if rec.is_none() || !active {
        index.graph.terms.values().filter(|r| words.iter().any(|w| r.term.to_lowercase().split_whitespace().any(|x| x == w))).map(|r| r.term.clone()).take(8).collect()
    } else {
        vec![]
    };
    let mut result = DefineResult { term: term.to_string(), slug: slug.clone(), defined: false, id: None, expr: None, anchor: None, breadcrumb: None, line: None, definition: None, as_of, scope: scope.map(str::to_string), usages: vec![], nearest };
    if let (Some(r), true) = (rec, active) {
        result.defined = true;
        result.id = Some(r.id.clone());
        result.expr = Some(r.expr.clone());
        result.anchor = Some(r.anchor.clone());
        result.breadcrumb = index.tree.get(&r.id).map(|n| n.breadcrumb.clone());
        result.line = Some(r.line);
        result.definition = Some(r.definition.clone());
        if usages {
            let filtered: Vec<&Usage> = r.usages.iter().filter(|u| scope.map(|s| index.tree.within(&u.id, s)).unwrap_or(true)).filter(|u| as_of.map(|d| index.tree.work_active_at(&u.id, d)).unwrap_or(true)).collect();
            result.usages = filtered.into_iter().map(|u| {
                let n = index.tree.get(&u.id);
                UsageEntry { id: u.id.clone(), label: n.map(|n| n.label.clone()).unwrap_or_default(), title: n.map(|n| n.title.clone()).unwrap_or_default(), count: u.count }
            }).collect();
        }
    }
    let shown = if result.defined { 1 + result.usages.len() } else { 0 };
    Ok(Response { header: header(index, shown, shown, vec![]), result })
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

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub query: String,
    pub mode: SearchMode,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub as_of: Option<NaiveDate>,
    pub include_superseded: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub rank: usize,
    pub id: String,
    pub expr: String,
    pub label: String,
    pub title: String,
    pub breadcrumb: String,
    pub kind: String,
    pub source: String,
    pub effective: Option<NaiveDate>,
    /// RRF score normalized so that rank 1 in both lists is 1.0.
    pub score: f64,
    pub lex_rank: Option<usize>,
    pub vec_rank: Option<usize>,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub query: String,
    pub mode: SearchMode,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub as_of: Option<NaiveDate>,
    pub include_superseded: bool,
    pub limit: usize,
    pub candidates_lexical: usize,
    pub candidates_vector: usize,
    pub embedding: Option<String>,
    /// Milestone 5 turns this on when nothing clears the confidence floor.
    pub abstained: bool,
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
            let first = body.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#')).unwrap_or("").trim();
            (None, first.chars().take(220).collect())
        }
    }
}

/// `sect search`: hybrid retrieval (spec B.4). Structural guarantees never come from here.
pub fn search(index: &Index, opts: &SearchOptions) -> Result<Response<SearchResult>> {
    let limit = opts.limit.clamp(1, 50);
    if let Some(s) = &opts.scope {
        if index.tree.get(s).is_none() {
            return Err(SectError::NotFound(s.clone()));
        }
    }
    let chunks = index.chunks()?;
    // Which Expressions may answer: as-of snapping (current-only by default), scope, source, kind.
    let mut allowed_exprs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for n in index.tree.nodes.values() {
        if opts.scope.as_deref().map(|s| !index.tree.within(&n.id, s)).unwrap_or(false) {
            continue;
        }
        if opts.source.as_deref().map(|s| n.source != s).unwrap_or(false) || opts.kind.as_deref().map(|k| n.kind != k).unwrap_or(false) {
            continue;
        }
        for e in &n.expressions {
            let active = match opts.as_of {
                Some(d) => index.tree.active_at(&e.expr, d, opts.include_superseded),
                None => opts.include_superseded || e.superseded_by.is_none(),
            };
            if active {
                allowed_exprs.insert(e.expr.clone());
            }
        }
    }
    let allowed_idx: std::collections::HashSet<usize> = chunks.iter().enumerate().filter(|(_, c)| allowed_exprs.contains(&c.expr)).map(|(i, _)| i).collect();
    let by_chunk: BTreeMap<&str, usize> = chunks.iter().enumerate().map(|(i, c)| (c.chunk_id.as_str(), i)).collect();

    let mut lex_ids: Vec<String> = Vec::new();
    let mut vec_ids: Vec<String> = Vec::new();
    let mut terms: Vec<String> = Vec::new();
    let mut embedding = None;
    if opts.mode != SearchMode::Vector {
        let lx = index.lexical()?;
        terms = lx.text_terms(&opts.query);
        let filter = sect_lexical::Filter { source: opts.source.clone(), kind: opts.kind.clone(), exprs: Some(allowed_exprs.clone()) };
        lex_ids = lx.search(&opts.query, &filter, sect_lexical::CANDIDATES)?.into_iter().filter(|h| by_chunk.contains_key(h.chunk_id.as_str())).map(|h| h.chunk_id).collect();
    }
    if opts.mode != SearchMode::Fts {
        if !index.has_semantic() {
            if opts.mode == SearchMode::Vector {
                return Err(SectError::Other("the semantic layer is not built (indexed with --embedding none); use --fts or rebuild the index".into()));
            }
        } else {
            let vectors = index.vectors()?;
            let embedder = index.embedder()?;
            embedding = Some(vectors.model.clone());
            let q = embedder.embed(&[opts.query.clone()])?.remove(0);
            let row_allowed: std::collections::HashSet<usize> = vectors.ids.iter().enumerate().filter(|(_, id)| by_chunk.get(id.as_str()).map(|i| allowed_idx.contains(i)).unwrap_or(false)).map(|(i, _)| i).collect();
            vec_ids = vectors.search(&q, sect_semantic::CANDIDATES, Some(&row_allowed)).into_iter().map(|(i, _)| vectors.ids[i].clone()).collect();
        }
    }
    if terms.is_empty() {
        terms = opts.query.split_whitespace().map(|w| w.to_lowercase()).collect();
    }
    let fused = sect_rank::fuse(&lex_ids, &vec_ids, (1.0, 1.0), sect_rank::RRF_K);
    // One hit per section. With --include-superseded every Expression is its own section so an
    // older text can appear next to the current one (milestone 5 penalizes it by -0.5).
    let per_expr = opts.include_superseded;
    let collapsed = sect_rank::collapse(fused, |chunk_id| by_chunk.get(chunk_id).map(|i| if per_expr { chunks[*i].expr.clone() } else { chunks[*i].id.clone() }).unwrap_or_else(|| chunk_id.to_string()));
    let matched = collapsed.len();
    let mut hits = Vec::new();
    for (rank, f) in collapsed.into_iter().take(limit).enumerate() {
        let Some(&ci) = by_chunk.get(f.chunk_id.as_str()) else { continue };
        let c = &chunks[ci];
        let node = index.tree.get(&c.id);
        let (line, snippet) = best_line(&c.body, &terms, c.line_start);
        let refs_in = index.graph.edges.iter().filter(|e| e.to == c.id && matches!(e.kind.as_str(), "references" | "overrides" | "narrows")).count();
        let refs_out = index.graph.edges.iter().filter(|e| e.from == c.id && e.kind == "references").count();
        hits.push(SearchHit {
            rank: rank + 1,
            id: c.id.clone(),
            expr: c.expr.clone(),
            label: c.label.clone(),
            title: c.title.clone(),
            breadcrumb: c.breadcrumb.clone(),
            kind: c.kind.clone(),
            source: c.source.clone(),
            effective: c.effective,
            score: (f.score * 10_000.0).round() / 10_000.0,
            lex_rank: f.lex_rank,
            vec_rank: f.vec_rank,
            chunk_id: c.chunk_id.clone(),
            part: c.part,
            nparts: c.nparts,
            line,
            snippet,
            overridden_by: node.map(|n| n.overridden_by.clone()).unwrap_or_default(),
            narrowed_by: node.map(|n| n.narrowed_by.clone()).unwrap_or_default(),
            refs_in,
            refs_out,
        });
    }
    let shown = hits.len();
    let extra = vec![("candidates-lexical".to_string(), lex_ids.len()), ("candidates-vector".to_string(), vec_ids.len()), ("limit".to_string(), limit)];
    let result = SearchResult { query: opts.query.clone(), mode: opts.mode, scope: opts.scope.clone(), source: opts.source.clone(), kind: opts.kind.clone(), as_of: opts.as_of, include_superseded: opts.include_superseded, limit, candidates_lexical: lex_ids.len(), candidates_vector: vec_ids.len(), embedding, abstained: false, hits };
    Ok(Response { header: header(index, shown, matched, extra), result })
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
}

/// `sect grep`: exhaustive exact/regex search, ripgrep-compatible, bounded by `--max-hits`.
/// `--annotate` names the section and paragraph of every line; `--scope` limits the files to a
/// subtree and `--source` to one source.
pub fn grep(index: &Index, opts: &sect_exact::GrepOptions, annotate: bool, scope: Option<&str>, source: Option<&str>) -> Result<Response<GrepResult>> {
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
    let raw = sect_exact::grep(&index.root, &opts)?;
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
                    let text = std::fs::read_to_string(index.root.join(&l.path)).unwrap_or_default();
                    let body = sect_corpus::split_front_matter(&text).map(|(_, b)| b).unwrap_or("");
                    let offset = text[..text.len() - body.len()].matches('\n').count();
                    (offset, paragraph_anchors(body))
                });
                let body_line = l.line as i64 - *offset as i64;
                let anchor = if body_line < 1 {
                    Some("front-matter".to_string())
                } else {
                    anchors.iter().filter(|a| a.line as i64 <= body_line).last().map(|a| a.anchor.clone())
                };
                Annotation { id: n.id.clone(), expr: e.expr.clone(), anchor, label: n.label.clone(), title: n.title.clone() }
            })
        } else {
            None
        };
        lines.push(GrepLineOut { path: l.path, line: l.line, kind: l.kind, text: l.text, break_before: l.break_before, annotation });
    }
    let note = if raw.truncated {
        Some(format!("{} matching lines across {} files exceed --max-hits {}; per-file counts follow. Narrow the pattern, add -g, --scope, or --source, or raise --max-hits.", raw.total_matches, raw.files_matched, raw.max_hits))
    } else {
        None
    };
    // "shown" counts matching lines only; context lines are extra and never counted as matches.
    let shown = match mode {
        "lines" => lines.iter().filter(|l| l.kind == sect_exact::LineKind::Match).count(),
        _ => raw.per_file.len(),
    };
    let mut extra = vec![("files-searched".to_string(), raw.files_searched), ("files-matched".to_string(), raw.files_matched), ("matching-lines".to_string(), raw.total_matches), ("max-hits".to_string(), raw.max_hits)];
    if raw.truncated {
        extra.push(("over-max-hits".to_string(), 1));
    }
    let result = GrepResult { patterns: opts.patterns.clone(), mode: mode.to_string(), scope: scope.map(str::to_string), source: source.map(str::to_string), lines, per_file: raw.per_file, files_searched: raw.files_searched, files_matched: raw.files_matched, total_matches: raw.total_matches, truncated: raw.truncated, max_hits: raw.max_hits, note };
    Ok(Response { header: header(index, shown, raw.total_matches, extra), result })
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
    let extra = vec![("warnings".to_string(), m.warnings.len()), ("unresolved-refs".to_string(), m.unresolved_refs)];
    Ok(Response { header: header(index, m.works, m.works, extra), result })
}
