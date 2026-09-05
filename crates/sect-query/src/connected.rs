use sect_core::knowledge::Evidence;
use sect_index::{search_state::SearchState, Index};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationMode {
    #[default]
    Off,
    Explicit,
    Verified,
}
impl RelationMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "explicit" => Some(Self::Explicit),
            "verified" => Some(Self::Verified),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PathStep {
    pub from: String,
    pub to: String,
    pub anchor: Option<String>,
    pub relation: String,
    pub evidence: Vec<Evidence>,
    pub line: Option<usize>,
    pub required_context: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RetrievalPath {
    pub seed: String,
    pub steps: Vec<PathStep>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TraversalReport {
    pub seeds: usize,
    pub hops: usize,
    pub candidate_limit: usize,
    pub discovered: usize,
    pub truncated: bool,
    pub concept_candidates: usize,
    pub ambiguous_concepts: Vec<String>,
}

pub struct Connected {
    pub paths: HashMap<String, RetrievalPath>,
    pub required: BTreeMap<(String, String, Option<String>), RetrievalPath>,
    pub report: TraversalReport,
}

pub fn expand(
    index: &Index,
    state: &SearchState,
    allowed: &HashSet<String>,
    opts: &super::SearchOptions,
    mode: RelationMode,
    types: &[String],
    fused: &mut Vec<sect_rank::Fused>,
) -> Connected {
    let mut result = Connected {
        paths: HashMap::new(),
        required: BTreeMap::new(),
        report: TraversalReport {
            hops: 2,
            candidate_limit: 200,
            ..Default::default()
        },
    };
    if mode == RelationMode::Off {
        return result;
    }
    let chunks = &state.chunks;
    let first_chunk = |expr: &str| {
        state
            .first_chunk_by_expr
            .get(expr)
            .filter(|_| allowed.contains(expr))
            .map(|&i| &chunks[i])
    };
    let norm = |s: &str| {
        format!(
            " {} ",
            s.to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let q = norm(&opts.query);
    let mut existing: HashSet<String> = fused.iter().map(|f| f.chunk_id.clone()).collect();
    if mode == RelationMode::Verified {
        for (alias, concepts) in &index.knowledge.aliases {
            if !q.contains(&norm(alias)) {
                continue;
            }
            if concepts.len() > 1 {
                result.report.ambiguous_concepts.push(alias.clone());
            }
            // Ambiguity adds alternatives; it never becomes a hard filter or identity merge.
            for (key, _) in concepts {
                for mention in index.knowledge.mentions.get(key).into_iter().flatten() {
                    if let Some(c) = first_chunk(mention.at.revision.as_str()) {
                        if existing.contains(&c.chunk_id) {
                            continue;
                        }
                        if result.report.concept_candidates == 200 {
                            result.report.truncated = true;
                            continue;
                        }
                        if existing.insert(c.chunk_id.clone()) {
                            fused.push(sect_rank::Fused {
                                chunk_id: c.chunk_id.clone(),
                                score: 0.45,
                                lex_rank: None,
                                vec_rank: None,
                            });
                            result.report.concept_candidates += 1;
                            result.paths.insert(
                                c.chunk_id.clone(),
                                RetrievalPath {
                                    seed: key.clone(),
                                    steps: vec![PathStep {
                                        from: key.clone(),
                                        to: mention.at.revision.clone(),
                                        anchor: mention.at.anchor.clone(),
                                        relation: "mentions".into(),
                                        evidence: mention.evidence.clone(),
                                        line: None,
                                        required_context: false,
                                    }],
                                },
                            );
                        }
                    }
                }
            }
        }
    }
    fused.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
    });
    let mut queue = VecDeque::new();
    let mut visited = HashSet::new();
    'seeds: for f in fused.iter() {
        if let Some(c) = state.by_chunk.get(f.chunk_id.as_str()).map(|&i| &chunks[i]) {
            for expr in std::iter::once(&c.expr).chain(c.spans.iter().map(|s| &s.expr)) {
                if allowed.contains(expr) && visited.insert(expr.clone()) {
                    queue.push_back((
                        expr.clone(),
                        f.score,
                        RetrievalPath {
                            seed: expr.clone(),
                            steps: vec![],
                        },
                    ));
                    if queue.len() == 20 {
                        break 'seeds;
                    }
                }
            }
        }
    }
    result.report.seeds = queue.len();
    while let Some((expr, score, path)) = queue.pop_front() {
        let date = opts
            .as_of
            .or_else(|| {
                if opts.include_superseded {
                    sect_core::split_expr(&expr)
                        .1
                        .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| chrono::Utc::now().date_naive());
        let mut arcs = Vec::new();
        for &edge_index in state
            .explicit_edges
            .get(expr.as_str())
            .into_iter()
            .flatten()
        {
            let e = &index.graph.edges[edge_index];
            if let Some(n) = index
                .tree
                .as_of(&e.to, date)
                .filter(|n| allowed.contains(&n.expr))
            {
                if e.anchor
                    .as_ref()
                    .map(|a| !n.anchors.contains(a))
                    .unwrap_or(false)
                {
                    continue;
                }
                arcs.push((
                    PathStep {
                        from: expr.clone(),
                        to: n.expr.clone(),
                        anchor: e.anchor.clone(),
                        relation: e.kind.clone(),
                        evidence: vec![],
                        line: e.line,
                        required_context: matches!(e.kind.as_str(), "overrides" | "narrows"),
                    },
                    0.7,
                ));
            }
        }
        if mode == RelationMode::Verified {
            for a in index.knowledge.adjacency.get(&expr).into_iter().flatten() {
                arcs.push((
                    PathStep {
                        from: expr.clone(),
                        to: a.to.revision.clone(),
                        anchor: a.to.anchor.clone(),
                        relation: a.relation.kind.clone(),
                        evidence: a.relation.evidence.clone(),
                        line: None,
                        required_context: a.required_context,
                    },
                    a.weight,
                ));
            }
        }
        for (step, weight) in arcs {
            if !allowed.contains(&step.to) || !types.is_empty() && !types.contains(&step.relation) {
                continue;
            }
            if step.required_context && path.steps.len() < 2 {
                if result.required.len() < 200 {
                    let mut required_path = path.clone();
                    required_path.steps.push(step.clone());
                    result
                        .required
                        .entry((path.seed.clone(), step.to.clone(), step.anchor.clone()))
                        .or_insert(required_path);
                } else {
                    result.report.truncated = true;
                }
            }
            if visited.contains(&step.to) {
                continue;
            }
            if path.steps.len() == 2 || result.report.discovered == 200 {
                result.report.truncated = true;
                continue;
            }
            let Some(c) = first_chunk(step.to.as_str()) else {
                continue;
            };
            visited.insert(step.to.clone());
            let score = score * weight / 1.5;
            let mut next = path.clone();
            next.steps.push(step);
            result
                .paths
                .entry(c.chunk_id.clone())
                .or_insert_with(|| next.clone());
            if existing.insert(c.chunk_id.clone()) {
                fused.push(sect_rank::Fused {
                    chunk_id: c.chunk_id.clone(),
                    score,
                    lex_rank: None,
                    vec_rank: None,
                });
            }
            result.report.discovered += 1;
            queue.push_back((
                next.steps.last().expect("added step").to.clone(),
                score,
                next,
            ));
        }
    }
    result
}
