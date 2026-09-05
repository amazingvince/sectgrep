use crate::connected::{PathStep, RetrievalPath};
use sect_core::knowledge::{CheckState, Relation};
use sect_index::Index;
use sect_struct::Direction;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet, VecDeque};

#[derive(Debug, Clone, Serialize)]
pub struct KnowledgeRef {
    pub depth: usize,
    pub other: String,
    pub relation: Relation,
    pub path: RetrievalPath,
}

pub fn traverse(
    index: &Index,
    id: &str,
    direction: Direction,
    kind: Option<&str>,
    depth: usize,
    include_superseded: bool,
) -> (Vec<KnowledgeRef>, bool) {
    let date = index.snapshot_date();
    let active = |r: &str| index.tree.active_at(r, date, include_superseded);
    let mut adjacency: BTreeMap<&str, Vec<(&str, &Relation)>> = BTreeMap::new();
    for relation in index.knowledge.artifacts.iter().flat_map(|a| &a.relations) {
        if relation.verification.state != CheckState::Passed
            || kind.is_some_and(|k| k != relation.kind)
            || !active(&relation.from.revision)
            || !active(&relation.to.revision)
        {
            continue;
        }
        if matches!(direction, Direction::Out | Direction::Both) {
            adjacency
                .entry(&relation.from.revision)
                .or_default()
                .push((&relation.to.revision, relation));
        }
        if matches!(direction, Direction::In | Direction::Both) {
            adjacency
                .entry(&relation.to.revision)
                .or_default()
                .push((&relation.from.revision, relation));
        }
    }
    let start = index
        .tree
        .resolve(id)
        .map(|(_, e)| e.expr.clone())
        .unwrap_or_else(|| id.into());
    let mut queue = VecDeque::from([(
        start.clone(),
        RetrievalPath {
            seed: start.clone(),
            steps: vec![],
        },
    )]);
    let mut visited = HashSet::from([start]);
    let mut edges = HashSet::new();
    let mut hits = Vec::new();
    let mut truncated = false;
    while let Some((from, path)) = queue.pop_front() {
        for (to, relation) in adjacency.get(from.as_str()).into_iter().flatten() {
            let key = (
                &relation.id,
                &relation.from.revision,
                &relation.to.revision,
                &relation.kind,
            );
            if edges.contains(&key) {
                continue;
            }
            if path.steps.len() >= depth.max(1) {
                truncated = true;
                continue;
            }
            edges.insert(key);
            let mut next = path.clone();
            let anchor = if **to == relation.to.revision {
                relation.to.anchor.clone()
            } else {
                relation.from.anchor.clone()
            };
            next.steps.push(PathStep {
                from: from.clone(),
                to: (*to).into(),
                anchor,
                relation: relation.kind.clone(),
                evidence: relation.evidence.clone(),
                line: None,
                required_context: false,
            });
            hits.push(KnowledgeRef {
                depth: next.steps.len(),
                other: (*to).into(),
                relation: (*relation).clone(),
                path: next.clone(),
            });
            if visited.insert((*to).to_string()) {
                queue.push_back(((*to).into(), next));
            }
        }
    }
    (hits, truncated)
}
