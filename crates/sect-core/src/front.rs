//! Front matter of a section file (spec B.2). Every field is optional at parse time so that
//! validation, not parsing, reports what is missing.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FrontMatter {
    pub id: Option<String>,
    pub node: Option<String>,
    pub source: Option<String>,
    pub title: Option<String>,
    pub level: Option<String>,
    pub kind: Option<String>,
    pub parent: Option<String>,
    pub order: Option<i64>,
    pub effective: Option<NaiveDate>,
    /// A reviewed identity retirement; earlier dated text remains readable.
    pub retired: Option<NaiveDate>,
    pub published: Option<NaiveDate>,
    pub supersedes: Option<String>,
    pub superseded_by: Option<String>,
    pub amended_by: Vec<String>,
    pub overrides: Vec<String>,
    pub narrows: Vec<Narrow>,
    pub defines: Vec<String>,
    pub definition_scope: Option<String>,
    pub authority: Option<String>,
    pub citation: Option<String>,
    pub tags: Vec<String>,
    pub context: Option<String>,
    /// `navigation` copies structure; `summary` (the legacy default) is authored context.
    pub context_kind: Option<String>,
    /// Generated contents lists and heading containers remain addressable navigation.
    pub retrieval_role: Option<String>,
    pub provenance: Option<Provenance>,
    pub actions: Vec<Action>,
    pub sources: Vec<NoteSource>,
    pub parts_affected: Vec<String>,
}

impl FrontMatter {
    /// The `context` prefix collapsed to single spaces.
    pub fn context_text(&self) -> String {
        self.context
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Anchor-level narrowing by an overlay: `{id, anchor}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Narrow {
    pub id: String,
    pub anchor: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Provenance {
    pub checks: std::collections::BTreeMap<String, crate::knowledge::CheckState>,
    pub raw: Option<String>,
    pub raw_sha256: Option<String>,
    pub locator: Option<serde_yaml_ng::Value>,
    pub legal_status: Option<String>,
    pub ingest_run: Option<String>,
    pub confidence: Option<f64>,
    pub verified_by: Vec<String>,
}

/// Action record parsed from a notice (spec B.2): an amendment as a first-class node.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Action {
    pub action_id: String,
    pub notice: Option<String>,
    pub target_id: String,
    pub target_anchor: Option<String>,
    pub kind: String,
    pub effective: Option<NaiveDate>,
    pub text: Option<String>,
}

/// A note's source pin: `{id, hash}` (spec D.4).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct NoteSource {
    pub id: String,
    pub hash: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fixture_style_front_matter() {
        let yaml = r#"
id: CFR:99-2.7
node: "99:1.1.1.2.7"
source: cfr-title-99
title: Fixed ladders
level: section
parent: CFR:99-2
order: 7
effective: 2026-01-01
supersedes: CFR:99-2.7@2024-01-01
superseded_by: null
amended_by: [FR:2026-00001#instr-1]
overrides: []
narrows:
  - {id: CFR:99-1.4, anchor: b}
defines: [ladder]
authority: "99 U.S.C. 655"
citation: null
tags: [ladders]
context: >
  Fixed ladder section.
provenance:
  raw: raw/x.xml
  raw_sha256: "00"
  locator: {xpath: "//DIV8"}
  legal_status: unofficial-xml
  ingest_run: 2026-09-03T00:00Z/fixture
  confidence: 1.0
  verified_by: [fixture]
"#;
        let fm: FrontMatter = serde_yaml_ng::from_str(yaml).unwrap();
        assert_eq!(fm.id.as_deref(), Some("CFR:99-2.7"));
        assert_eq!(fm.effective, NaiveDate::from_ymd_opt(2026, 1, 1));
        assert_eq!(fm.supersedes.as_deref(), Some("CFR:99-2.7@2024-01-01"));
        assert!(fm.superseded_by.is_none());
        assert_eq!(fm.amended_by, vec!["FR:2026-00001#instr-1"]);
        assert_eq!(fm.narrows[0].anchor.as_deref(), Some("b"));
        assert_eq!(fm.context_text(), "Fixed ladder section.");
        assert_eq!(
            fm.provenance.as_ref().unwrap().legal_status.as_deref(),
            Some("unofficial-xml")
        );
    }
}
