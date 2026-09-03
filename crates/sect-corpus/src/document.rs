use std::collections::BTreeSet;
use std::sync::LazyLock;

use comrak::nodes::{AstNode, NodeValue};
use comrak::{Arena, Options};
use regex::Regex;
use sect_core::{expr_id, FrontMatter, Result, SectError};
use serde::{Deserialize, Serialize};

use crate::cite::Resolver;
use crate::walk::CorpusFile;

static LINK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\(([^)\s]*)\)").unwrap());
static LABEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\(([a-z]{1,4}|\d{1,2})\)\s").unwrap());
static ID_LIKE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9]*:").unwrap());
const ROMAN: &[&str] = &["ii", "iii", "iv", "vi", "vii", "viii", "ix"];

/// How a cross-reference was found.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Via {
    /// A markdown link whose target is a Work id.
    Link,
    /// The fallback regex extractor over prose (spec B.4).
    Prose,
    /// Declared in front matter (overrides, narrows, supersedes, amended_by, defines).
    FrontMatter,
}

/// A cross-reference from this document to a Work id, optionally with an anchor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Link {
    pub target: String,
    pub anchor: Option<String>,
    /// 1-based line in the body.
    pub line: usize,
    pub via: Via,
}

/// A GFM table found in the body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Table {
    pub line: usize,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl Table {
    /// One sentence per row: `Header: cell; Header: cell` (spec B.4 "table rows chunked as sentences").
    pub fn flat_rows(&self) -> Vec<String> {
        self.rows
            .iter()
            .map(|r| self.header.iter().zip(r.iter()).map(|(h, c)| format!("{h}: {c}")).collect::<Vec<_>>().join("; "))
            .collect()
    }
}

/// A paragraph anchor and the body line it starts on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnchorLine {
    pub anchor: String,
    pub line: usize,
}

/// A defined term's definition paragraph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Definition {
    pub term: String,
    pub slug: String,
    pub line: usize,
    pub text: String,
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
    pub paragraph_anchors: Vec<AnchorLine>,
    pub links: Vec<Link>,
    pub tables: Vec<Table>,
    pub definitions: Vec<Definition>,
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
        let mut out: Vec<String> = self.paragraph_anchors.iter().map(|a| a.anchor.clone()).collect();
        out.extend(self.front.defines.iter().map(|t| slug(t)));
        out
    }

    pub fn link_targets(&self) -> impl Iterator<Item = &Link> {
        self.links.iter().filter(|l| l.via == Via::Link)
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

/// Paragraph labels `(a)`, `(1)`, `(i)` become anchors `a`, `a-1`, `a-1-i`, with their line numbers.
pub fn paragraph_anchors(body: &str) -> Vec<AnchorLine> {
    let mut anchors = Vec::new();
    let mut lvl1: Option<String> = None;
    let mut lvl2: Option<String> = None;
    for (i, raw) in body.lines().enumerate() {
        let line = raw.trim();
        let Some(m) = LABEL_RE.captures(line) else { continue };
        let lab = m[1].to_string();
        let anchor = if lab.chars().all(|c| c.is_ascii_digit()) {
            let a = match &lvl1 {
                Some(a) => format!("{a}-{lab}"),
                None => lab.clone(),
            };
            lvl2 = Some(lab);
            a
        } else if ROMAN.contains(&lab.as_str()) && lvl2.is_some() {
            format!("{}-{}-{lab}", lvl1.clone().unwrap_or_default(), lvl2.clone().unwrap())
        } else {
            lvl1 = Some(lab.clone());
            lvl2 = None;
            lab
        };
        anchors.push(AnchorLine { anchor, line: i + 1 });
    }
    anchors
}

fn node_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut s = String::new();
    for n in node.descendants() {
        match &n.data.borrow().value {
            NodeValue::Text(t) => s.push_str(t),
            NodeValue::Code(c) => s.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => s.push(' '),
            _ => {}
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Markdown links whose target is a Work id (`CFR:99-1.5#a-2`), plus GFM tables, from the comrak AST.
pub fn parse_markdown(body: &str) -> (Vec<Link>, Vec<Table>) {
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    let root = comrak::parse_document(&arena, body, &options);
    let mut links = Vec::new();
    let mut tables = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        let line = data.sourcepos.start.line;
        match &data.value {
            NodeValue::Link(l) if ID_LIKE_RE.is_match(&l.url) => {
                let (target, anchor) = match l.url.split_once('#') {
                    Some((t, a)) => (t.to_string(), Some(a.to_string())),
                    None => (l.url.clone(), None),
                };
                links.push(Link { target, anchor, line, via: Via::Link });
            }
            NodeValue::Table(_) => {
                let mut header = Vec::new();
                let mut rows = Vec::new();
                for row in node.children() {
                    let is_header = matches!(row.data.borrow().value, NodeValue::TableRow(true));
                    let cells: Vec<String> = row.children().map(node_text).collect();
                    if is_header {
                        header = cells;
                    } else {
                        rows.push(cells);
                    }
                }
                tables.push(Table { line, header, rows });
            }
            _ => {}
        }
    }
    (links, tables)
}

/// Prose citations outside markdown links, resolved through the sources' `id_pattern`s.
pub fn prose_links(body: &str, resolver: &Resolver) -> Vec<Link> {
    // Blank out link syntax so a linked citation is not counted twice.
    let blanked = LINK_RE.replace_all(body, |c: &regex::Captures| " ".repeat(c[0].len()));
    let mut out = Vec::new();
    for c in resolver.find_all(&blanked) {
        let line = blanked[..c.offset].matches('\n').count() + 1;
        out.push(Link { target: c.id, anchor: c.anchor, line, via: Via::Prose });
    }
    out
}

fn strip_emphasis(s: &str) -> String {
    s.replace('*', "").replace('_', "")
}

/// The definition paragraph for each term in `defines`: the paragraph starting with `*Term*`.
pub fn definitions(body: &str, defines: &[String]) -> Vec<Definition> {
    let mut out = Vec::new();
    let lines: Vec<&str> = body.lines().collect();
    for term in defines {
        let needle = format!("*{}*", term).to_lowercase();
        let found = lines.iter().enumerate().find(|(_, l)| l.trim_start().to_lowercase().starts_with(&needle));
        let (line, text) = match found {
            Some((i, l)) => (i + 1, strip_emphasis(l.trim())),
            None => (0, String::new()),
        };
        out.push(Definition { term: term.clone(), slug: slug(term), line, text });
    }
    out
}

fn mapping_keys(value: &serde_yaml_ng::Value) -> BTreeSet<String> {
    match value {
        serde_yaml_ng::Value::Mapping(m) => m.keys().filter_map(|k| k.as_str().map(|s| s.to_string())).collect(),
        _ => BTreeSet::new(),
    }
}

pub fn parse_text(rel: &str, source: &str, text: &str, resolver: &Resolver) -> Result<Document> {
    let path = std::path::PathBuf::from(rel);
    let (yaml, body) = split_front_matter(text).ok_or_else(|| SectError::MissingFrontMatter { path: path.clone() })?;
    let value: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(yaml).map_err(|e| SectError::FrontMatter { path: path.clone(), message: e.to_string() })?;
    if !value.is_mapping() {
        return Err(SectError::FrontMatter { path, message: "front matter is not a mapping".into() });
    }
    let keys = mapping_keys(&value);
    let provenance_keys = value.get("provenance").map(mapping_keys).unwrap_or_default();
    let front: FrontMatter =
        serde_yaml_ng::from_value(value).map_err(|e| SectError::FrontMatter { path: path.clone(), message: e.to_string() })?;
    let body = body.trim_end().to_string();
    let (mut links, tables) = parse_markdown(&body);
    // A section citing itself ("paragraph (a) of this section", its own heading) is not a cross-reference.
    links.extend(prose_links(&body, resolver).into_iter().filter(|l| Some(l.target.as_str()) != front.id.as_deref()));
    let definitions = definitions(&body, &front.defines);
    Ok(Document {
        rel: rel.to_string(),
        source: source.to_string(),
        keys,
        provenance_keys,
        paragraph_anchors: paragraph_anchors(&body),
        links,
        tables,
        definitions,
        word_count: body.split_whitespace().count(),
        front,
        body,
    })
}

pub fn parse_document(file: &CorpusFile, resolver: &Resolver) -> Result<Document> {
    let text = std::fs::read_to_string(&file.abs).map_err(|e| SectError::io(&file.abs, e))?;
    parse_text(&file.rel, &file.source, &text, resolver)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: CFR:99-1.5\nsource: cfr-title-99\ntitle: Exemptions\nparent: CFR:99-1\neffective: 2024-01-01\ndefines: [competent person]\n---\n\n# § 1.5 Exemptions\n\n(a) This title does not apply to:\n\n(1) Domestic; see [§ 3.5](CFR:99-3.5) and [§ 1.3(b)](CFR:99-1.3#b).\n\n(2) Farms, as in § 2.9 and part 3.\n\n(b) Still subject.\n\n*Competent person* means a person who is capable.\n\n| Event | Report within |\n|---|---|\n| Fatality | 8 hours |\n| Amputation | 24 hours |\n";

    #[test]
    fn splits_and_parses() {
        let d = parse_text("x/y.md", "cfr-title-99", SAMPLE, &Resolver::default()).unwrap();
        assert_eq!(d.id(), Some("CFR:99-1.5"));
        assert_eq!(d.expr().as_deref(), Some("CFR:99-1.5@2024-01-01"));
        let anchors: Vec<&str> = d.paragraph_anchors.iter().map(|a| a.anchor.as_str()).collect();
        assert_eq!(anchors, vec!["a", "a-1", "a-2", "b"]);
        assert_eq!(d.paragraph_anchors[1].line, 5);
        assert_eq!(d.anchors().last().map(String::as_str), Some("competent-person"));
        assert_eq!(d.links.len(), 2);
        assert_eq!(d.links[1].anchor.as_deref(), Some("b"));
        assert_eq!(d.links[1].line, 5);
        assert_eq!(d.tables.len(), 1);
        assert_eq!(d.tables[0].header, vec!["Event", "Report within"]);
        assert_eq!(d.tables[0].flat_rows()[1], "Report within: 24 hours".replace("Report within: 24 hours", "Event: Amputation; Report within: 24 hours"));
        assert_eq!(d.definitions[0].text, "Competent person means a person who is capable.");
        assert!(d.keys.contains("parent"));
        assert!(!d.keys.contains("order"));
    }

    #[test]
    fn prose_refs_use_source_patterns() {
        let mut sources = std::collections::BTreeMap::new();
        sources.insert(
            "cfr-title-99".to_string(),
            sect_core::SourceConfig {
                name: "cfr-title-99".into(),
                kind: "base".into(),
                id_prefix: "CFR:99-".into(),
                id_pattern: Some(r"(?i)(?:§\s*)(?P<part>[1-3])\.(?P<section>\d{1,2})".into()),
                id_template: Some("CFR:99-{part}.{section}".into()),
                ..Default::default()
            },
        );
        let d = parse_text("x.md", "cfr-title-99", SAMPLE, &Resolver::new(&sources)).unwrap();
        let prose: Vec<(&str, usize)> = d.links.iter().filter(|l| l.via == Via::Prose).map(|l| (l.target.as_str(), l.line)).collect();
        assert_eq!(prose, vec![("CFR:99-2.9", 7), ("CFR:99-3", 7)]);
        // Linked citations are not double counted as prose.
        assert_eq!(d.links.iter().filter(|l| l.target == "CFR:99-3.5").count(), 1);
    }

    #[test]
    fn crlf_and_missing_front_matter() {
        let crlf = SAMPLE.replace('\n', "\r\n");
        let d = parse_text("x.md", "s", &crlf, &Resolver::default()).unwrap();
        assert_eq!(d.id(), Some("CFR:99-1.5"));
        assert!(parse_text("x.md", "s", "# no front matter\n", &Resolver::default()).is_err());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Walking-working surface"), "walking-working-surface");
        assert_eq!(slug("physician or other licensed health care professional"), "physician-or-other-licensed-health-care-professional");
    }
}
