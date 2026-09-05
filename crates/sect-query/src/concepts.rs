use sect_core::knowledge::{CheckState, Concept, Mention};
use sect_index::Index;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct ConceptMatch {
    pub identity: String,
    pub concept: Concept,
    pub mentions: Vec<Mention>,
}

pub fn lookup(index: &Index, query: &str, scope: Option<&str>) -> Vec<ConceptMatch> {
    let q = query.trim().to_lowercase();
    let mut result = BTreeMap::new();
    for a in &index.knowledge.artifacts {
        for concept in &a.concepts {
            if concept.verification.state != CheckState::Passed
                || !(q == "*"
                    || concept.id.to_lowercase() == q
                    || concept.label.to_lowercase() == q
                    || concept.aliases.iter().any(|v| v.to_lowercase() == q))
            {
                continue;
            }
            if let (Some(requested), Some(declared)) = (scope, &concept.scope) {
                if !index.tree.within(requested, declared)
                    && !index.tree.within(declared, requested)
                {
                    continue;
                }
            }
            let identity = format!("{}@{}:{}", a.profile.name, a.profile.version, concept.id);
            let mentions = index
                .knowledge
                .mentions
                .get(&identity)
                .into_iter()
                .flatten()
                .filter(|m| {
                    index
                        .tree
                        .active_at(&m.at.revision, index.snapshot_date(), false)
                        && scope
                            .map(|s| {
                                index
                                    .tree
                                    .within(sect_core::split_expr(&m.at.revision).0, s)
                            })
                            .unwrap_or(true)
                })
                .cloned()
                .collect();
            result.insert(
                identity.clone(),
                ConceptMatch {
                    identity,
                    concept: concept.clone(),
                    mentions,
                },
            );
        }
    }
    result.into_values().collect()
}
