use sect_core::{knowledge::*, Result, SectError};
use sect_struct::Tree;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Accepted claims must still point to the exact raw bytes the reviewer saw.
pub fn validate_raw(root: &std::path::Path, artifacts: &[KnowledgeArtifact]) -> Result<()> {
    let mut hashes = BTreeMap::new();
    for artifact in artifacts {
        let evidence = artifact
            .concepts
            .iter()
            .filter(|c| c.verification.state == CheckState::Passed)
            .flat_map(|c| &c.evidence)
            .chain(
                artifact
                    .mentions
                    .iter()
                    .filter(|m| m.verification.state == CheckState::Passed)
                    .flat_map(|m| &m.evidence),
            )
            .chain(
                artifact
                    .relations
                    .iter()
                    .filter(|r| r.verification.state == CheckState::Passed)
                    .flat_map(|r| &r.evidence),
            );
        for e in evidence {
            let relative = std::path::Path::new(&e.raw);
            if relative.components().any(|c| {
                !matches!(
                    c,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            }) {
                return Err(SectError::Other(format!(
                    "knowledge raw path must be corpus-relative: {}",
                    e.raw
                )));
            }
            let hash = if let Some(hash) = hashes.get(&e.raw) {
                hash
            } else {
                let path = root.join(relative);
                let bytes = std::fs::read(&path).map_err(|err| SectError::io(&path, err))?;
                hashes
                    .entry(e.raw.clone())
                    .or_insert_with(|| format!("{:x}", Sha256::digest(bytes)))
            };
            if *hash != e.raw_sha256.to_lowercase() {
                return Err(SectError::Other(format!(
                    "knowledge evidence raw hash changed: {}",
                    e.raw
                )));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Arc {
    pub to: Endpoint,
    pub relation: Relation,
    pub weight: f64,
    pub required_context: bool,
}

#[derive(Debug, Clone, Default)]
pub struct KnowledgeIndex {
    pub artifacts: Vec<KnowledgeArtifact>,
    pub adjacency: BTreeMap<String, Vec<Arc>>,
    pub aliases: BTreeMap<String, Vec<(String, String)>>,
    pub mentions: BTreeMap<String, Vec<Mention>>,
}

impl KnowledgeIndex {
    pub fn build(artifacts: Vec<KnowledgeArtifact>, tree: &Tree) -> Result<Self> {
        let mut out = Self::default();
        let mut identities = BTreeMap::new();
        let mut profiles = BTreeMap::new();
        for artifact in &artifacts {
            artifact.validate().map_err(SectError::Other)?;
            let profile_key = format!("{}@{}", artifact.profile.name, artifact.profile.version);
            if profiles
                .insert(profile_key.clone(), artifact.profile.clone())
                .is_some_and(|p| p != artifact.profile)
            {
                return Err(SectError::Other(format!(
                    "conflicting profile {profile_key}"
                )));
            }
            let endpoint = |e: &Endpoint| -> Result<()> {
                let (_, revision) = tree
                    .resolve(&e.revision)
                    .filter(|(_, r)| r.expr == e.revision)
                    .ok_or_else(|| {
                        SectError::Other(format!("unknown knowledge revision {}", e.revision))
                    })?;
                if let Some(a) = &e.anchor {
                    if !revision.anchors.contains(a)
                        && !revision
                            .front
                            .defines
                            .iter()
                            .any(|t| sect_corpus::slug(t) == *a)
                    {
                        return Err(SectError::Other(format!(
                            "unknown knowledge anchor {}#{a}",
                            e.revision
                        )));
                    }
                }
                Ok(())
            };
            for c in &artifact.concepts {
                let key = format!("{profile_key}:{}", c.id);
                if identities
                    .insert(key.clone(), c.clone())
                    .is_some_and(|prior| prior != *c)
                {
                    return Err(SectError::Other(format!(
                        "conflicting concept identity {key}"
                    )));
                }
                if let Some(scope) = &c.scope {
                    if tree.get(scope).is_none() {
                        return Err(SectError::Other(format!("unknown concept scope {scope}")));
                    }
                }
                if c.verification.state != CheckState::Passed {
                    continue;
                }
                for label in std::iter::once(&c.label).chain(c.aliases.iter()) {
                    out.aliases
                        .entry(label.to_lowercase())
                        .or_default()
                        .push((key.clone(), c.label.clone()));
                }
            }
            for m in &artifact.mentions {
                endpoint(&m.at)?;
                let concept = artifact
                    .concepts
                    .iter()
                    .find(|c| c.id == m.concept)
                    .unwrap();
                if let Some(scope) = &concept.scope {
                    let work = sect_core::split_expr(&m.at.revision).0;
                    if work != scope && !tree.ancestors(work).iter().any(|n| n.id == *scope) {
                        return Err(SectError::Other(format!(
                            "mention outside concept scope {}",
                            m.concept
                        )));
                    }
                }
                if m.verification.state == CheckState::Passed {
                    out.mentions
                        .entry(format!("{profile_key}:{}", m.concept))
                        .or_default()
                        .push(m.clone());
                }
            }
            for r in &artifact.relations {
                endpoint(&r.from)?;
                endpoint(&r.to)?;
                if r.verification.state != CheckState::Passed {
                    continue;
                }
                let t = artifact
                    .profile
                    .relation_types
                    .iter()
                    .find(|t| t.name == r.kind)
                    .unwrap();
                if matches!(
                    t.direction,
                    RelationDirection::Out | RelationDirection::Both
                ) {
                    out.adjacency
                        .entry(r.from.revision.clone())
                        .or_default()
                        .push(Arc {
                            to: r.to.clone(),
                            relation: r.clone(),
                            weight: t.weight,
                            required_context: t.required_context,
                        });
                }
                if matches!(t.direction, RelationDirection::In | RelationDirection::Both) {
                    out.adjacency
                        .entry(r.to.revision.clone())
                        .or_default()
                        .push(Arc {
                            to: r.from.clone(),
                            relation: r.clone(),
                            weight: t.weight,
                            required_context: t.required_context,
                        });
                }
            }
        }
        for aliases in out.aliases.values_mut() {
            aliases.sort();
            aliases.dedup();
        }
        out.artifacts = artifacts;
        Ok(out)
    }
}
