//! Generation-bound search lookups and a bounded cache of revision/filter selections.
use crate::{query_chunks::QueryChunk, Index};
use chrono::NaiveDate;
use sect_core::{Result, SectError};
use sect_corpus::Via;
use sect_semantic::VectorIndex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, PartialEq, Eq)]
pub struct SelectionKey {
    pub date: NaiveDate,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub include_superseded: bool,
}

pub struct Selection {
    pub expressions: HashSet<String>,
    /// No lexical restriction is needed when every indexed expression is eligible.
    pub all_expressions: bool,
    vector_rows: OnceLock<Option<HashSet<usize>>>,
}
impl Selection {
    pub fn vector_rows<'a>(
        &'a self,
        vectors: &VectorIndex,
        state: &SearchState,
    ) -> Option<&'a HashSet<usize>> {
        self.vector_rows
            .get_or_init(|| {
                let rows: HashSet<usize> = vectors
                    .ids
                    .iter()
                    .enumerate()
                    .filter(|(_, id)| {
                        state
                            .by_chunk
                            .get(id.as_str())
                            .is_some_and(|&i| state.chunks[i].selected(&self.expressions))
                    })
                    .map(|(i, _)| i)
                    .collect();
                (rows.len() != vectors.ids.len()).then_some(rows)
            })
            .as_ref()
    }
}

pub struct SearchState {
    pub chunks: Arc<Vec<QueryChunk>>,
    pub by_chunk: HashMap<String, usize>,
    pub first_chunk_by_expr: HashMap<String, usize>,
    pub context_by_parent: HashMap<String, Vec<String>>,
    pub refs_in: HashMap<String, usize>,
    pub explicit_edges: HashMap<String, Vec<usize>>,
    expressions: HashSet<String>,
    selections: Mutex<VecDeque<(SelectionKey, Arc<Selection>)>>,
}
impl SearchState {
    pub(crate) fn new(index: &Index, chunks: Arc<Vec<QueryChunk>>) -> Self {
        let mut by_chunk = HashMap::with_capacity(chunks.len());
        let mut first_chunk_by_expr = HashMap::new();
        let mut expressions = HashSet::new();
        for (i, c) in chunks.iter().enumerate() {
            by_chunk.insert(c.chunk_id.clone(), i);
            first_chunk_by_expr.entry(c.expr.clone()).or_insert(i);
            expressions.insert(c.expr.clone());
            for (j, span) in c.spans.iter().enumerate() {
                by_chunk.insert(format!("{}~s{j}", c.chunk_id), i);
                first_chunk_by_expr.entry(span.expr.clone()).or_insert(i);
                expressions.insert(span.expr.clone());
            }
        }
        let mut context_by_parent: HashMap<String, Vec<String>> = HashMap::new();
        for node in index.tree.nodes.values() {
            for e in &node.expressions {
                let title = e.front.title.as_deref().unwrap_or_default().to_lowercase();
                if ["definition", "definitions", "scope", "applicability"]
                    .iter()
                    .any(|word| title == *word || title.ends_with(&format!(" {word}")))
                {
                    if let Some(parent) = &e.front.parent {
                        context_by_parent
                            .entry(parent.clone())
                            .or_default()
                            .push(e.expr.clone());
                    }
                }
            }
        }
        let mut refs_in = HashMap::new();
        let mut explicit_edges: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, e) in index.graph.edges.iter().enumerate() {
            if matches!(e.kind.as_str(), "references" | "overrides" | "narrows") {
                if e.from != e.to {
                    *refs_in.entry(e.to.clone()).or_default() += 1;
                }
                if e.resolved && matches!(e.via, Via::Link | Via::FrontMatter) {
                    explicit_edges
                        .entry(e.from_expr.clone())
                        .or_default()
                        .push(i);
                }
            }
        }
        Self {
            chunks,
            by_chunk,
            first_chunk_by_expr,
            context_by_parent,
            refs_in,
            explicit_edges,
            expressions,
            selections: Default::default(),
        }
    }

    pub fn selection(&self, index: &Index, key: SelectionKey) -> Result<Arc<Selection>> {
        let mut cache = self
            .selections
            .lock()
            .map_err(|_| SectError::Other("selection cache lock poisoned".into()))?;
        if let Some(i) = cache.iter().position(|(k, _)| k == &key) {
            let entry = cache.remove(i).expect("position exists");
            let result = entry.1.clone();
            cache.push_back(entry);
            return Ok(result);
        }
        let mut expressions = HashSet::new();
        for n in index.tree.nodes.values() {
            if key
                .scope
                .as_deref()
                .is_some_and(|s| !index.tree.within(&n.id, s))
                || key.source.as_deref().is_some_and(|s| n.source != s)
                || key.kind.as_deref().is_some_and(|k| n.kind != k)
            {
                continue;
            }
            for e in &n.expressions {
                if index
                    .tree
                    .active_at(&e.expr, key.date, key.include_superseded)
                {
                    expressions.insert(e.expr.clone());
                }
            }
        }
        let all_expressions = self.expressions.is_subset(&expressions);
        let selection = Arc::new(Selection {
            expressions,
            all_expressions,
            vector_rows: OnceLock::new(),
        });
        if cache.len() == 4 {
            cache.pop_front();
        }
        cache.push_back((key, selection.clone()));
        Ok(selection)
    }
}
