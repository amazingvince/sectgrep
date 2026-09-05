//! `_source.yaml`: one per source directory (spec B.2).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InputMode {
    #[default]
    Markdown,
    Document,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SourceConfig {
    pub name: String,
    /// Markdown files are authoritative by default. Document mode reads *.sections.json.
    pub input_mode: InputMode,
    /// base | overlay | notice | internal | note
    pub kind: String,
    pub title: Option<String>,
    pub publisher: Option<String>,
    /// Higher wins; notes lowest.
    pub precedence: i64,
    pub id_prefix: String,
    pub id_pattern: Option<String>,
    pub id_template: Option<String>,
    pub anchor_template: Option<String>,
    /// official | unofficial-xml | derived
    pub legal_status: String,
    pub version: Option<String>,
    pub acquire: Option<String>,
    /// Directory of this source, relative to the corpus root (forward slashes). Filled by the loader.
    #[serde(skip)]
    pub dir: String,
}

impl SourceConfig {
    pub fn is_base(&self) -> bool {
        self.kind == "base"
    }

    /// Display name for breadcrumbs of non-base sources.
    pub fn display_title(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.name)
    }
}
