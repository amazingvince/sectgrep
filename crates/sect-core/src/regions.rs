//! Source regions are durable evidence. Search chunks are disposable index products.
use crate::knowledge::{Derivation, Locator};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const DOCUMENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TableCell {
    pub id: String,
    pub row: u32,
    pub column: u32,
    pub row_span: u32,
    pub column_span: u32,
    pub text: String,
    /// Explicit parser associations only; empty is not a claim that no header exists.
    pub headers: Vec<String>,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub id: String,
    pub native_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub locator: Locator,
    pub order: u32,
    pub parent: Option<String>,
    pub heading_level: Option<u32>,
    pub cells: Vec<TableCell>,
    pub caption_of: Option<String>,
    pub footnote_of: Vec<String>,
    pub uncertainty: Vec<String>,
    /// Why this region is absent from searchable text; the region itself remains intact.
    pub exclusion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AddressableUnit {
    pub id: String,
    pub title: String,
    pub parent: Option<String>,
    pub regions: Vec<String>,
    pub native_id: Option<String>,
    pub content_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IdentityTransition {
    pub effective: String,
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub basis: String,
    pub receipt_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IdentityLedger {
    pub schema_version: u32,
    pub document: String,
    pub next_id: u32,
    pub revisions: BTreeMap<String, Vec<AddressableUnit>>,
    pub transitions: Vec<IdentityTransition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DocumentArtifact {
    pub schema_version: u32,
    pub document: String,
    pub effective: String,
    pub raw: String,
    pub raw_sha256: String,
    pub format: String,
    pub parser: String,
    pub regions: Vec<Region>,
    pub units: Vec<AddressableUnit>,
    pub derivations: Vec<Derivation>,
}

impl DocumentArtifact {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != DOCUMENT_VERSION
            || self.document.is_empty()
            || chrono::NaiveDate::parse_from_str(&self.effective, "%Y-%m-%d").is_err()
            || self.raw_sha256.len() != 64
            || !self.raw_sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("invalid document identity/version/hash".into());
        }
        let regions: BTreeMap<_, _> = self.regions.iter().map(|r| (&r.id, r)).collect();
        let units: BTreeMap<_, _> = self.units.iter().map(|u| (&u.id, u)).collect();
        if regions.len() != self.regions.len() || units.len() != self.units.len() {
            return Err("duplicate region or unit identity".into());
        }
        let mut orders = HashSet::new();
        for r in &self.regions {
            if r.id.is_empty() || !r.locator.valid() || !orders.insert(r.order) {
                return Err("invalid region identity, locator, or reading order".into());
            }
            let cells: HashSet<_> = r.cells.iter().map(|c| &c.id).collect();
            if cells.len() != r.cells.len()
                || r.cells.iter().any(|c| {
                    c.id.is_empty()
                        || c.row_span == 0
                        || c.column_span == 0
                        || c.headers.iter().any(|h| !cells.contains(h))
                })
            {
                return Err("invalid table cell/header association".into());
            }
            for target in r.caption_of.iter().chain(r.footnote_of.iter()) {
                if !regions.contains_key(target) || target == &r.id {
                    return Err("invalid region association".into());
                }
            }
            let mut seen = HashSet::from([&r.id]);
            let mut parent = r.parent.as_ref();
            while let Some(id) = parent {
                if !seen.insert(id) {
                    return Err("region hierarchy cycle".into());
                }
                parent = regions
                    .get(id)
                    .ok_or("unknown region parent")?
                    .parent
                    .as_ref();
            }
        }
        let mut covered = HashSet::new();
        for u in &self.units {
            if u.id.is_empty()
                || u.regions.is_empty()
                || u.content_sha256.len() != 64
                || !u.content_sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || u.regions
                    .iter()
                    .any(|id| !regions.contains_key(id) || !covered.insert(id))
            {
                return Err("unknown or multiply assigned unit region".into());
            }
            let mut seen = HashSet::from([&u.id]);
            let mut parent = u.parent.as_ref();
            while let Some(id) = parent {
                if !seen.insert(id) {
                    return Err("unit hierarchy cycle".into());
                }
                parent = units.get(id).ok_or("unknown unit parent")?.parent.as_ref();
            }
        }
        if self
            .regions
            .iter()
            .any(|r| r.exclusion.is_none() && !covered.contains(&r.id))
        {
            return Err("region missing from units without an exclusion reason".into());
        }
        Ok(())
    }
}
