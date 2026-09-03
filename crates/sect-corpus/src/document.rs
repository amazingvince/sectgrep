use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use sect_core::{expr_id, FrontMatter, Result, SectError};
use serde::Serialize;

use crate::walk::CorpusFile;

static LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\(([A-Z]+:[^)#\s]+)(?:#([^)\s]+))?\)").unwrap());
static LABEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\(([a-z]{1,4}|\d{1,2})\)\s").unwrap());
const ROMAN: &[&str] = &["ii", "iii", "iv", "vi", "vii", "viii", "ix"];

/// A markdown link whose target is a Work id, optionally with an anchor.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Link {
    pub target: String,
    pub anchor: Option<String>,
}

/// A parsed section file.
#[derive(Debug, Clone)]
pub struct Document {
    pub rel: String,
    pub source: String,
    pub front: FrontMatter,
    /// Front-matter keys that were present (so validation can tell `parent: null` from a missing key).
    pub keys: BTreeSet<String>,
    pub provenance_keys: BTreeSet<String>,
    pub body: String,
    pub paragraph_anchors: Vec<String>,
    pub links: Vec<Link>,
    pub word_count: usize,
}

impl Document {
    pub fn id(&self) -> Option<&str> {
        self.front.id.as_deref().filter(|s| !s.is_empty())
    }

    pub fn expr(&self) -> Option<String> {
        self.id().map(|id| expr_id(id, self.front.effective))
    }

    /// Paragraph anchors plus one slug per defined term (spec B.2).
    pub fn anchors(&self) -> Vec<String> {
        let mut out = self.paragraph_anchors.clone();
        out.extend(self.front.defines.iter().map(|t| slug(t)));
        out
    }
}

/// `guardrail system` -> `guardrail-system`.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Split a file into its YAML front matter and body. Accepts LF or CRLF and a leading BOM.
pub fn split_front_matter(text: &str) -> Option<(&str, &str)> {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let t = t.strip_prefix("---")?;
    let t = t.strip_prefix("\r\n").or_else(|| t.strip_prefix('\n'))?;
    let mut from = 0;
    loop {
        let idx = t[from..].find("\n---")? + from;
        let after = &t[idx + 4..];
        let after_trim = after.strip_prefix('\r').unwrap_or(after);
        if after_trim.is_empty() || after_trim.starts_with('\n') {
            let yaml = t[..idx].trim_end_matches('\r');
            let body = after_trim.trim_start_matches(['\r', '\n']);
            return Some((yaml, body));
        }
        from = idx + 4;
    }
}

/// Paragraph labels `(a)`, `(1)`, `(i)` become anchors `a`, `a-1`, `a-1-i`.
pub fn paragraph_anchors(body: &str) -> Vec<String> {
    let mut anchors = Vec::new();
    let mut lvl1: Option<String> = None;
    let mut lvl2: Option<String> = None;
    for raw in body.lines() {
        let line = raw.trim();
        let Some(m) = LABEL_RE.captures(line) else { continue };
        let lab = m[1].to_string();
        if lab.chars().all(|c| c.is_ascii_digit()) {
            anchors.push(match &lvl1 {
                Some(a) => format!("{a}-{lab}"),
                None => lab.clone(),
            });
            lvl2 = Some(lab);
        } else if ROMAN.contains(&lab.as_str()) && lvl2.is_some() {
            anchors.push(format!("{}-{}-{lab}", lvl1.clone().unwrap_or_default(), lvl2.clone().unwrap()));
        } else {
            lvl1 = Some(lab.clone());
            lvl2 = None;
            anchors.push(lab);
        }
    }
    anchors
}

pub fn links(body: &str) -> Vec<Link> {
    LINK_RE
        .captures_iter(body)
        .map(|c| Link { target: c[2].to_string(), anchor: c.get(3).map(|m| m.as_str().to_string()) })
        .collect()
}

fn mapping_keys(value: &serde_yaml_ng::Value) -> BTreeSet<String> {
    match value {
        serde_yaml_ng::Value::Mapping(m) => {
            m.keys().filter_map(|k| k.as_str().map(|s| s.to_string())).collect()
        }
        _ => BTreeSet::new(),
    }
}

pub fn parse_text(rel: &str, source: &str, text: &str) -> Result<Document> {
    let path = std::path::PathBuf::from(rel);
    let (yaml, body) = split_front_matter(text).ok_or_else(|| SectError::MissingFrontMatter { path: path.clone() })?;
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)
        .map_err(|e| SectError::FrontMatter { path: path.clone(), message: e.to_string() })?;
    if !value.is_mapping() {
        return Err(SectError::FrontMatter { path, message: "front matter is not a mapping".into() });
    }
    let keys = mapping_keys(&value);
    let provenance_keys = value.get("provenance").map(mapping_keys).unwrap_or_default();
    let front: FrontMatter = serde_yaml_ng::from_value(value)
        .map_err(|e| SectError::FrontMatter { path: path.clone(), message: e.to_string() })?;
    let body = body.trim_end().to_string();
    Ok(Document {
        rel: rel.to_string(),
        source: source.to_string(),
        keys,
        provenance_keys,
        paragraph_anchors: paragraph_anchors(&body),
        links: links(&body),
        word_count: body.split_whitespace().count(),
        front,
        body,
    })
}

pub fn parse_document(file: &CorpusFile) -> Result<Document> {
    let text = std::fs::read_to_string(&file.abs).map_err(|e| SectError::io(&file.abs, e))?;
    parse_text(&file.rel, &file.source, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: CFR:99-1.5\nsource: cfr-title-99\ntitle: Exemptions\nparent: CFR:99-1\neffective: 2024-01-01\ndefines: [competent person]\n---\n\n# § 1.5 Exemptions\n\n(a) This title does not apply to:\n\n(1) Domestic; see [§ 3.5](CFR:99-3.5) and [§ 1.3(b)](CFR:99-1.3#b).\n\n(2) Farms.\n\n(b) Still subject.\n";

    #[test]
    fn splits_and_parses() {
        let d = parse_text("x/y.md", "cfr-title-99", SAMPLE).unwrap();
        assert_eq!(d.id(), Some("CFR:99-1.5"));
        assert_eq!(d.expr().as_deref(), Some("CFR:99-1.5@2024-01-01"));
        assert_eq!(d.paragraph_anchors, vec!["a", "a-1", "a-2", "b"]);
        assert_eq!(d.anchors().last().map(String::as_str), Some("competent-person"));
        assert_eq!(d.links.len(), 2);
        assert_eq!(d.links[1].anchor.as_deref(), Some("b"));
        assert!(d.keys.contains("parent"));
        assert!(!d.keys.contains("order"));
        assert!(d.body.starts_with("# § 1.5"));
    }

    #[test]
    fn crlf_and_missing_front_matter() {
        let crlf = SAMPLE.replace('\n', "\r\n");
        let d = parse_text("x.md", "s", &crlf).unwrap();
        assert_eq!(d.id(), Some("CFR:99-1.5"));
        assert!(parse_text("x.md", "s", "# no front matter\n").is_err());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Walking-working surface"), "walking-working-surface");
        assert_eq!(slug("physician or other licensed health care professional"), "physician-or-other-licensed-health-care-professional");
    }
}
