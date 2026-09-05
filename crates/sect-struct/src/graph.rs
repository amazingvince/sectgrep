//! The structural graph (spec B.4 "Structural"): `xrefs.jsonl`, `actions.jsonl`, `terms.json`,
//! `tables.jsonl`, all derived from front matter and the markdown AST by traversal.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::Arc;

use chrono::NaiveDate;
use regex::Regex;
static DECLARED_SCOPE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)(?:as used in|for (?:the )?purposes of) this (title|chapter|part|section)")
        .unwrap()
});
use sect_core::{split_expr, Result, SectError};
use sect_corpus::{slug, Document, Via};
use serde::{Deserialize, Serialize};

use crate::tree::Tree;

pub const GRAPH_CODEC: &str = "shared-term-usages-v1";

pub const EDGE_TYPES: &[&str] = &[
    "references",
    "overrides",
    "narrows",
    "supersedes",
    "amends",
    "defines",
];

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
    pub expr: String,
    pub count: usize,
}

/// Definitions share the corpus's immutable mention list. Each view excludes
/// its own defining Work, preserving the existing serialized usages array.
#[derive(Debug, Clone, Default)]
pub struct TermUsages {
    rows: Arc<Vec<Usage>>,
    excluded_work: Option<String>,
}
impl TermUsages {
    pub fn iter(&self) -> impl Iterator<Item = &Usage> {
        self.rows
            .iter()
            .filter(|row| self.excluded_work.as_deref() != Some(row.id.as_str()))
    }
    pub fn is_empty(&self) -> bool {
        self.iter().next().is_none()
    }
}
impl PartialEq for TermUsages {
    fn eq(&self, other: &Self) -> bool {
        self.iter().eq(other.iter())
    }
}
impl Eq for TermUsages {}
impl Serialize for TermUsages {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_seq(self.iter())
    }
}
impl<'de> Deserialize<'de> for TermUsages {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Ok(Self {
            rows: Arc::new(Vec::<Usage>::deserialize(deserializer)?),
            excluded_work: None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TermRec {
    pub scope: String,
    pub slug: String,
    pub term: String,
    pub id: String,
    pub expr: String,
    pub anchor: String,
    pub source: String,
    pub line: usize,
    pub definition: String,
    /// Current Works whose body uses the term, with match counts; the defining section excluded.
    pub usages: TermUsages,
}

#[derive(Serialize, Deserialize)]
struct StoredTerm {
    #[serde(flatten)]
    record: TermRec,
    usage_list: String,
    excluded_work: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct TermFile {
    schema_version: u32,
    terms: BTreeMap<String, StoredTerm>,
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

pub fn build_graph(docs: &[Document], tree: &Tree) -> Graph {
    let action_ids: HashSet<&str> = docs
        .iter()
        .flat_map(|d| d.front.actions.iter().map(|a| a.action_id.as_str()))
        .collect();
    let mut g = Graph::default();
    let resolves = |id: &str| -> bool {
        let (work, _) = split_expr(id);
        tree.get(work).is_some()
    };
    for d in docs {
        let (Some(id), Some(expr)) = (d.id().map(str::to_string), d.expr()) else {
            continue;
        };
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
            g.edges.push(Edge {
                from: id.clone(),
                from_expr: expr.clone(),
                to: t.clone(),
                anchor: None,
                kind: "overrides".into(),
                via: Via::FrontMatter,
                line: None,
                resolved: resolves(t),
            });
        }
        for n in &d.front.narrows {
            g.edges.push(Edge {
                from: id.clone(),
                from_expr: expr.clone(),
                to: n.id.clone(),
                anchor: n.anchor.clone(),
                kind: "narrows".into(),
                via: Via::FrontMatter,
                line: None,
                resolved: resolves(&n.id),
            });
        }
        if let Some(s) = &d.front.supersedes {
            g.edges.push(Edge {
                from: id.clone(),
                from_expr: expr.clone(),
                to: s.clone(),
                anchor: None,
                kind: "supersedes".into(),
                via: Via::FrontMatter,
                line: None,
                resolved: tree.resolve(s).is_some(),
            });
        }
        for a in &d.front.amended_by {
            g.edges.push(Edge {
                from: a.clone(),
                from_expr: a.clone(),
                to: id.clone(),
                anchor: None,
                kind: "amends".into(),
                via: Via::FrontMatter,
                line: None,
                resolved: action_ids.contains(a.as_str()),
            });
        }
        for t in &d.front.defines {
            g.edges.push(Edge {
                from: id.clone(),
                from_expr: expr.clone(),
                to: format!("term:{}", slug(t)),
                anchor: None,
                kind: "defines".into(),
                via: Via::FrontMatter,
                line: None,
                resolved: true,
            });
        }
        for a in &d.front.actions {
            let produced = docs
                .iter()
                .find(|x| x.front.amended_by.contains(&a.action_id))
                .and_then(|x| x.expr());
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
            g.tables.push(TableRec {
                id: id.clone(),
                expr: expr.clone(),
                index: i,
                line: t.line,
                header: t.header.clone(),
                rows: t.rows.clone(),
                flat_rows: t.flat_rows(),
            });
        }
    }
    // Terms: defined in current Expressions; usages counted over current section-level
    // Expressions of other Works with one combined regex pass per document (not one per term).
    let mut term_owner: BTreeMap<String, (String, String)> = BTreeMap::new(); // lowercase term -> (slug, defining id)
    for d in docs {
        let Some(id) = d.id() else { continue };
        for def in &d.definitions {
            term_owner
                .entry(def.term.to_lowercase())
                .or_insert((def.slug.clone(), id.to_string()));
        }
    }
    let mut counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new(); // slug -> id -> count
    if !term_owner.is_empty() {
        let mut alts: Vec<&String> = term_owner.keys().collect();
        alts.sort_by_key(|t| std::cmp::Reverse(t.len()));
        let pattern = format!(
            r"\b(?:{})s?\b",
            alts.iter()
                .map(|t| regex::escape(t))
                .collect::<Vec<_>>()
                .join("|")
        );
        if let Ok(re) = Regex::new(&pattern) {
            for other in docs {
                let Some(oid) = other.id() else { continue };
                let level = other.front.level.as_deref().unwrap_or("section");
                if matches!(
                    level,
                    "title"
                        | "subtitle"
                        | "chapter"
                        | "subchapter"
                        | "part"
                        | "subpart"
                        | "subjectgroup"
                ) {
                    continue;
                }
                let low = other.body.to_lowercase();
                for m in re.find_iter(&low) {
                    let mut t = m.as_str();
                    let owner = term_owner.get(t).or_else(|| {
                        t.strip_suffix('s').and_then(|s| {
                            t = s;
                            term_owner.get(s)
                        })
                    });
                    if let Some((slug, _)) = owner {
                        *counts
                            .entry(slug.clone())
                            .or_default()
                            .entry(other.expr().unwrap_or_else(|| oid.to_string()))
                            .or_default() += 1;
                    }
                }
            }
        }
    }
    let usage_rows: BTreeMap<String, Arc<Vec<Usage>>> = counts
        .into_iter()
        .map(|(slug, rows)| {
            (
                slug,
                Arc::new(
                    rows.into_iter()
                        .map(|(expr, count)| Usage {
                            id: split_expr(&expr).0.to_string(),
                            expr,
                            count,
                        })
                        .collect(),
                ),
            )
        })
        .collect();
    let empty_usages = Arc::new(Vec::new());
    for d in docs {
        let (Some(id), Some(expr)) = (d.id().map(str::to_string), d.expr()) else {
            continue;
        };
        for def in &d.definitions {
            let usages = TermUsages {
                rows: usage_rows.get(&def.slug).unwrap_or(&empty_usages).clone(),
                excluded_work: Some(id.clone()),
            };
            let declared_level = DECLARED_SCOPE
                .captures(&d.body)
                .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()));
            let scope = d
                .front
                .definition_scope
                .clone()
                .or_else(|| {
                    declared_level.and_then(|level| {
                        if d.front.level.as_deref() == Some(level.as_str()) {
                            Some(id.clone())
                        } else {
                            tree.ancestors(&id)
                                .into_iter()
                                .find(|n| n.level == level)
                                .map(|n| n.id.clone())
                        }
                    })
                })
                .or_else(|| d.front.parent.clone())
                .unwrap_or_else(|| id.clone());
            g.terms.insert(
                format!("{}@{}#{}", def.slug, expr, def.line),
                TermRec {
                    scope,
                    slug: def.slug.clone(),
                    term: def.term.clone(),
                    id: id.clone(),
                    expr: expr.clone(),
                    anchor: def.slug.clone(),
                    source: d.source.clone(),
                    line: def.line,
                    definition: def.text.clone(),
                    usages,
                },
            );
        }
    }
    g.edges.sort_by(|a, b| {
        (&a.from_expr, &a.kind, &a.to, &a.line).cmp(&(&b.from_expr, &b.kind, &b.to, &b.line))
    });
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
        self.terms.values().find(|r| r.slug == slug(term))
    }

    /// Resolve the closest declaring scope; equally applicable definitions remain ambiguous.
    pub fn definitions<'a>(
        &'a self,
        term: &str,
        tree: &Tree,
        scope: Option<&str>,
        date: Option<chrono::NaiveDate>,
    ) -> Vec<&'a TermRec> {
        let key = slug(term);
        let mut found: Vec<(&TermRec, usize)> = self
            .terms
            .values()
            .filter(|r| r.slug == key)
            .filter(|r| {
                date.map(|d| tree.active_at(&r.expr, d, false))
                    .unwrap_or_else(|| {
                        tree.get(&r.id)
                            .map(|n| n.current == r.expr)
                            .unwrap_or(false)
                    })
            })
            .filter_map(|r| {
                let declaring = r.scope.as_str();
                let distance = match scope {
                    None => 0,
                    Some(s) if s == r.id || s == declaring => 0,
                    Some(s) if tree.within(s, declaring) => {
                        tree.ancestors(s)
                            .iter()
                            .position(|n| n.id == declaring)
                            .unwrap_or(0)
                            + 1
                    }
                    Some(s) if tree.within(&r.id, s) => 1000,
                    Some(_) => return None,
                };
                Some((r, distance))
            })
            .collect();
        found.sort_by_key(|(r, d)| (*d, r.expr.as_str(), r.line));
        let nearest = found.first().map(|(_, d)| *d);
        found
            .into_iter()
            .filter(|(_, d)| Some(*d) == nearest)
            .map(|(r, _)| r)
            .collect()
    }

    pub fn tables_of(&self, expr: &str) -> Vec<&TableRec> {
        self.tables.iter().filter(|t| t.expr == expr).collect()
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        write_jsonl(&dir.join("xrefs.jsonl"), &self.edges)?;
        write_jsonl(&dir.join("actions.jsonl"), &self.actions)?;
        write_jsonl(&dir.join("tables.jsonl"), &self.tables)?;
        let mut keys = HashMap::new();
        let mut lists: BTreeMap<String, &[Usage]> = BTreeMap::new();
        let mut terms = BTreeMap::new();
        for (key, record) in &self.terms {
            let pointer = Arc::as_ptr(&record.usages.rows);
            let next = format!("u{}", keys.len());
            let usage_list = keys
                .entry(pointer)
                .or_insert_with(|| {
                    lists.insert(next.clone(), record.usages.rows.as_slice());
                    next
                })
                .clone();
            let mut metadata = record.clone();
            metadata.usages = TermUsages::default();
            terms.insert(
                key.clone(),
                StoredTerm {
                    record: metadata,
                    usage_list,
                    excluded_work: record.usages.excluded_work.clone(),
                },
            );
        }
        write_json(&dir.join("term-usages.json"), &lists)?;
        write_json(
            &dir.join("terms.json"),
            &TermFile {
                schema_version: 1,
                terms,
            },
        )
    }

    pub fn load(dir: &Path) -> Result<Graph> {
        let p = dir.join("terms.json");
        let pool_path = dir.join("term-usages.json");
        let terms = if pool_path.exists() {
            let pools: BTreeMap<String, Vec<Usage>> = read_json(&pool_path)?;
            let pools: BTreeMap<_, _> = pools
                .into_iter()
                .map(|(key, rows)| (key, Arc::new(rows)))
                .collect();
            let stored: TermFile = read_json(&p)?;
            if stored.schema_version != 1 {
                return Err(SectError::Other(
                    "unsupported shared term-usage schema".into(),
                ));
            }
            stored
                .terms
                .into_iter()
                .map(|(key, mut term)| {
                    if !term.record.usages.is_empty() {
                        return Err(SectError::Other(
                            "normalized term unexpectedly inlines usages".into(),
                        ));
                    }
                    term.record.usages = TermUsages {
                        rows: pools
                            .get(&term.usage_list)
                            .ok_or_else(|| {
                                SectError::Other(format!(
                                    "missing term-usage list: {}",
                                    term.usage_list
                                ))
                            })?
                            .clone(),
                        excluded_work: term.excluded_work,
                    };
                    Ok((key, term.record))
                })
                .collect::<Result<_>>()?
        } else {
            // Pinned legacy generations retain their inline usages arrays. A new
            // envelope with a missing pool fails this legacy parse instead of
            // silently losing all usages.
            read_json(&p)?
        };
        Ok(Graph {
            edges: read_jsonl(&dir.join("xrefs.jsonl"))?,
            actions: read_jsonl(&dir.join("actions.jsonl"))?,
            tables: read_jsonl(&dir.join("tables.jsonl"))?,
            terms,
        })
    }
}

fn write_jsonl<T: Serialize>(path: &Path, rows: &[T]) -> Result<()> {
    let mut writer = BufWriter::with_capacity(
        1024 * 1024,
        std::fs::File::create(path).map_err(|e| SectError::io(path, e))?,
    );
    for r in rows {
        serde_json::to_writer(&mut writer, r)?;
        writer
            .write_all(b"\n")
            .map_err(|e| SectError::io(path, e))?;
    }
    writer.flush().map_err(|e| SectError::io(path, e))
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>> {
    let mut reader = BufReader::with_capacity(
        1024 * 1024,
        std::fs::File::open(path).map_err(|e| SectError::io(path, e))?,
    );
    let mut line = String::new();
    let mut rows = Vec::new();
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
            rows.push(serde_json::from_str(&line)?);
        }
    }
    Ok(rows)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let file = std::fs::File::open(path).map_err(|e| SectError::io(path, e))?;
    // Slice deserialization avoids the reader's per-byte overhead. Bound the temporary
    // allocation; large legacy inline-usage artifacts retain the streaming path.
    if file.metadata().map_err(|e| SectError::io(path, e))?.len() <= 128 * 1024 * 1024 {
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(128 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| SectError::io(path, e))?;
        if bytes.len() > 128 * 1024 * 1024 {
            return Err(SectError::Other(
                "structural artifact grew during read".into(),
            ));
        }
        return Ok(serde_json::from_slice(&bytes)?);
    }
    let reader = BufReader::with_capacity(1024 * 1024, file);
    Ok(serde_json::from_reader(reader)?)
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut writer = BufWriter::with_capacity(
        1024 * 1024,
        std::fs::File::create(path).map_err(|e| SectError::io(path, e))?,
    );
    serde_json::to_writer(&mut writer, value)?;
    writer.flush().map_err(|e| SectError::io(path, e))
}
