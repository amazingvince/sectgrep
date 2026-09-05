use sect_core::{
    regions::{DocumentArtifact, IdentityLedger},
    Result, SectError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

pub const SOURCE_CODEC: &str = "json-f64-roundtrip-v1";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceIndex {
    pub documents: BTreeMap<String, DocumentArtifact>,
    pub identities: BTreeMap<String, IdentityLedger>,
    pub coverage: BTreeMap<String, serde_json::Value>,
}
impl SourceIndex {
    pub fn build(
        root: &Path,
        inputs: &BTreeMap<String, PathBuf>,
        tree: &sect_struct::Tree,
    ) -> Result<Self> {
        let mut index = Self::default();
        let mut raw_hashes = BTreeMap::new();
        for (relative, file) in inputs {
            if relative.ends_with(".document.json") {
                let document: DocumentArtifact = serde_json::from_slice(
                    &std::fs::read(file).map_err(|e| SectError::io(file, e))?,
                )?;
                document.validate().map_err(SectError::Other)?;
                let raw = Path::new(&document.raw);
                if raw
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
                {
                    return Err(SectError::Other("document raw path escapes corpus".into()));
                }
                let actual = raw_hashes.entry(document.raw.clone()).or_insert_with(|| {
                    std::fs::read(root.join(raw))
                        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                });
                if actual.as_ref().ok() != Some(&document.raw_sha256) {
                    return Err(SectError::Other(
                        "document raw evidence hash mismatch".into(),
                    ));
                }
                let by_id: BTreeMap<_, _> = document.regions.iter().map(|r| (&r.id, r)).collect();
                for unit in &document.units {
                    let text = unit
                        .regions
                        .iter()
                        .map(|id| by_id[id].text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    if format!("{:x}", Sha256::digest(text)) != unit.content_sha256 {
                        return Err(SectError::Other(
                            "unit text hash differs from source regions".into(),
                        ));
                    }
                    let revision = format!("{}@{}", unit.id, document.effective);
                    if !tree
                        .nodes
                        .get(&unit.id)
                        .is_some_and(|node| node.expressions.iter().any(|e| e.expr == revision))
                    {
                        return Err(SectError::Other(format!(
                            "source unit has no indexed revision: {revision}"
                        )));
                    }
                }
                let key = format!("{}@{}", document.document, document.effective);
                if index.documents.insert(key, document).is_some() {
                    return Err(SectError::Other(
                        "duplicate document revision artifact".into(),
                    ));
                }
            } else if relative.ends_with(".identity.json") {
                let ledger: IdentityLedger = serde_json::from_slice(
                    &std::fs::read(file).map_err(|e| SectError::io(file, e))?,
                )?;
                if ledger.schema_version != 1
                    || index
                        .identities
                        .insert(ledger.document.clone(), ledger)
                        .is_some()
                {
                    return Err(SectError::Other(
                        "invalid or duplicate identity ledger".into(),
                    ));
                }
            } else if relative.ends_with(".coverage.json") {
                index.coverage.insert(
                    relative.clone(),
                    serde_json::from_slice(
                        &std::fs::read(file).map_err(|e| SectError::io(file, e))?,
                    )?,
                );
            }
        }
        for ledger in index.identities.values() {
            if ledger.next_id == 0 {
                return Err(SectError::Other("invalid next identity allocation".into()));
            }
            for (date, units) in &ledger.revisions {
                let key = format!("{}@{}", ledger.document, date);
                if !index.documents.get(&key).is_some_and(|d| &d.units == units) {
                    return Err(SectError::Other(
                        "identity revision differs from its source document".into(),
                    ));
                }
            }
            for transition in &ledger.transitions {
                let current = ledger.revisions.get(&transition.effective).ok_or_else(|| {
                    SectError::Other("identity transition has no revision".into())
                })?;
                let prior = ledger
                    .revisions
                    .range(..transition.effective.clone())
                    .next_back()
                    .map(|(_, units)| units.as_slice())
                    .unwrap_or_default();
                if transition
                    .to
                    .iter()
                    .any(|id| !current.iter().any(|u| &u.id == id))
                    || transition
                        .from
                        .iter()
                        .any(|id| !prior.iter().any(|u| &u.id == id))
                    || transition.basis.starts_with("human")
                        && !transition.receipt_sha256.as_ref().is_some_and(|h| {
                            h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())
                        })
                {
                    return Err(SectError::Other(
                        "invalid identity transition endpoints or receipt".into(),
                    ));
                }
            }
        }
        Ok(index)
    }
    pub fn unit(
        &self,
        revision: &str,
    ) -> Option<(&DocumentArtifact, &sect_core::regions::AddressableUnit)> {
        let (id, date) = sect_core::split_expr(revision);
        self.documents
            .values()
            .filter(|d| date.is_some_and(|date| date == d.effective))
            .find_map(|d| d.units.iter().find(|u| u.id == id).map(|u| (d, u)))
    }
}
