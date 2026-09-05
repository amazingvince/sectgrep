//! Portable, versioned enrichment contract. Source statements remain addressable evidence;
//! accepted relations are optional retrieval aids, never replacements for source text.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const KNOWLEDGE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Passed,
    Failed,
    Unchecked,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    pub state: CheckState,
    pub method: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PageLocation {
    pub page: u32,
    pub elements: Vec<u32>,
    pub bbox: Option<[f64; 4]>,
}

impl PageLocation {
    fn valid(&self) -> bool {
        self.page > 0
            && self
                .bbox
                .as_ref()
                .is_none_or(|b| b.iter().all(|n| n.is_finite()) && b[0] <= b[2] && b[1] <= b[3])
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Locator {
    Page {
        page: u32,
        elements: Vec<u32>,
        bbox: Option<[f64; 4]>,
    },
    /// Ordered source boxes for one region. The quote belongs to their union;
    /// individual boxes do not assert character-level quote alignment.
    Pages {
        locations: Vec<PageLocation>,
    },
    Xml {
        xpath: String,
    },
    /// An XPath within a named XML member of an Office Open XML ZIP package.
    Office {
        part: String,
        xpath: String,
    },
    Text {
        line_start: u32,
        line_end: u32,
    },
    Sheet {
        sheet: String,
        range: String,
    },
    Slide {
        slide: u32,
        shape: Option<String>,
    },
    Record {
        pointer: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub raw: String,
    pub raw_sha256: String,
    pub locator: Locator,
    pub quote: String,
    pub verification: Verification,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub revision: String,
    pub anchor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Concept {
    /// Profile-scoped identifier. Equal labels never imply equal identities.
    pub id: String,
    pub label: String,
    pub aliases: Vec<String>,
    pub kind: String,
    pub scope: Option<String>,
    pub definition: Option<String>,
    pub evidence: Vec<Evidence>,
    pub verification: Verification,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Mention {
    pub concept: String,
    pub at: Endpoint,
    pub evidence: Vec<Evidence>,
    pub verification: Verification,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Relation {
    pub id: String,
    pub from: Endpoint,
    pub to: Endpoint,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub qualifiers: BTreeMap<String, String>,
    pub evidence: Vec<Evidence>,
    pub verification: Verification,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelationDirection {
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelationType {
    pub name: String,
    pub description: String,
    pub direction: RelationDirection,
    pub weight: f64,
    pub required_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub version: String,
    pub unit_types: Vec<String>,
    pub concept_types: Vec<String>,
    pub metadata_fields: Vec<String>,
    pub relation_types: Vec<RelationType>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Derivation {
    pub stage: String,
    pub implementation: String,
    pub recipe_sha256: String,
    /// Input paths and SHA-256 hashes, including parser, prompt, model, and profile artifacts.
    pub inputs: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeArtifact {
    pub schema_version: u32,
    pub profile: Profile,
    pub concepts: Vec<Concept>,
    pub mentions: Vec<Mention>,
    pub relations: Vec<Relation>,
    pub derivations: Vec<Derivation>,
}

fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

impl Locator {
    pub fn valid(&self) -> bool {
        match self {
            Self::Pages { locations } => {
                locations.len() >= 2 && locations.iter().all(PageLocation::valid)
            }
            Self::Page { page, bbox, .. } => {
                *page > 0
                    && bbox
                        .as_ref()
                        .map(|b| b.iter().all(|n| n.is_finite()) && b[0] <= b[2] && b[1] <= b[3])
                        .unwrap_or(true)
            }
            Self::Text {
                line_start,
                line_end,
            } => *line_start > 0 && line_end >= line_start,
            Self::Xml { xpath } => xpath.starts_with('/'),
            Self::Office { part, xpath } => {
                crate::sections::safe_relative(part)
                    && part.ends_with(".xml")
                    && xpath.starts_with('/')
            }
            Self::Sheet { sheet, range } => !sheet.trim().is_empty() && !range.trim().is_empty(),
            Self::Slide { slide, .. } => *slide > 0,
            Self::Record { pointer } => pointer.is_empty() || pointer.starts_with('/'),
        }
    }
}

#[cfg(test)]
mod locator_tests {
    use super::*;

    #[test]
    fn compound_page_and_office_locations_require_valid_native_addresses() {
        let native: [f64; 4] = serde_json::from_str(
            "[230.69199999999998,234.31689460000007,309.1325310999999,266.72469720000004]",
        )
        .unwrap();
        assert_eq!(native[0].to_bits(), 230.69199999999998_f64.to_bits());
        assert_eq!(
            native,
            serde_json::from_str::<[f64; 4]>(&serde_json::to_string(&native).unwrap()).unwrap()
        );
        let page = PageLocation {
            page: 3,
            elements: vec![7],
            bbox: Some([1.0, 2.0, 3.0, 4.0]),
        };
        let good = Locator::Pages {
            locations: vec![
                page.clone(),
                PageLocation {
                    page: 4,
                    ..page.clone()
                },
            ],
        };
        assert!(good.valid());
        let json = serde_json::to_value(&good).unwrap();
        assert_eq!(serde_json::from_value::<Locator>(json).unwrap(), good);
        assert!(!Locator::Pages {
            locations: vec![page.clone()]
        }
        .valid());
        assert!(!Locator::Pages {
            locations: vec![page.clone(), PageLocation { page: 0, ..page }]
        }
        .valid());
        assert!(Locator::Office {
            part: "word/document.xml".into(),
            xpath: "/*[1]/*[1]/*[3]".into()
        }
        .valid());
        for part in [
            "../document.xml",
            "/word/document.xml",
            "word\\document.xml",
            "C:/document.xml",
            "word/evil\u{85}.xml",
        ] {
            assert!(!Locator::Office {
                part: part.into(),
                xpath: "/*[1]".into()
            }
            .valid());
        }
    }
}

fn supported(e: &[Evidence], v: &Verification) -> bool {
    v.state != CheckState::Passed
        || (!v.method.trim().is_empty()
            && !e.is_empty()
            && e.iter().all(|e| {
                hash(&e.raw_sha256)
                    && e.locator.valid()
                    && !e.raw.is_empty()
                    && !e.quote.trim().is_empty()
                    && e.verification.state == CheckState::Passed
                    && !e.verification.method.trim().is_empty()
            }))
}

impl KnowledgeArtifact {
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.schema_version != KNOWLEDGE_VERSION {
            return Err("unsupported knowledge schema version".into());
        }
        if self.profile.name.is_empty() || self.profile.version.is_empty() {
            return Err("profile identity is required".into());
        }
        for d in &self.derivations {
            if d.stage.is_empty()
                || d.implementation.is_empty()
                || !hash(&d.recipe_sha256)
                || d.inputs
                    .values()
                    .chain(d.outputs.values())
                    .any(|h| !hash(h))
            {
                return Err("invalid derivation identity or hash".into());
            }
        }
        let mut kinds = HashSet::new();
        for t in &self.profile.relation_types {
            if t.name.is_empty()
                || !kinds.insert(&t.name)
                || !t.weight.is_finite()
                || !(0.0..=1.0).contains(&t.weight)
            {
                return Err("invalid or duplicate relation type".into());
            }
        }
        let mut concepts = HashSet::new();
        for c in &self.concepts {
            if c.id.is_empty()
                || !concepts.insert(&c.id)
                || !self.profile.concept_types.contains(&c.kind)
                || !supported(&c.evidence, &c.verification)
            {
                return Err(format!("invalid concept {}", c.id));
            }
        }
        let mut ids = HashSet::new();
        for r in &self.relations {
            if r.id.is_empty()
                || !ids.insert(&r.id)
                || !kinds.contains(&r.kind)
                || !supported(&r.evidence, &r.verification)
            {
                return Err(format!("invalid relation {}", r.id));
            }
        }
        for m in &self.mentions {
            if !concepts.contains(&m.concept) || !supported(&m.evidence, &m.verification) {
                return Err(format!("invalid mention {}", m.concept));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passed_requires_located_evidence() {
        assert!(!supported(
            &[],
            &Verification {
                state: CheckState::Passed,
                method: "two readers".into(),
                reason: None
            }
        ));
        assert!(supported(
            &[],
            &Verification {
                state: CheckState::Unchecked,
                method: "pending".into(),
                reason: None
            }
        ));
    }
}
