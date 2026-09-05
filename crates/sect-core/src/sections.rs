//! Canonical section projections grouped by source document, independent of Markdown exports.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SECTION_BUNDLE_VERSION: u32 = 1;
pub const SECTION_RECIPE: &str = "canonical-markdown-v1";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SectionBundle {
    pub schema_version: u32,
    pub recipe: String,
    pub document: String,
    /// Corpus-relative organized document artifacts, including historical revisions, with SHA-256.
    pub artifacts: BTreeMap<String, String>,
    /// Virtual paths preserve the exact-search, citation, and revision contracts.
    pub sections: BTreeMap<String, String>,
}

pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
