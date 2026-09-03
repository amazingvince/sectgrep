//! Citation-shaped text -> Work id, driven by each source's `id_pattern` / `id_template` /
//! `anchor_template` (spec B.3 citation short-circuit; spec-changes #1). Also the fallback
//! prose cross-reference extractor of spec B.4 ("§ 1.5", "99 CFR 1.5", "part 2").

use std::collections::BTreeMap;

use regex::Regex;
use sect_core::SourceConfig;

#[derive(Debug, Clone)]
pub struct CitePattern {
    pub source: String,
    pub regex: Regex,
    pub id_template: String,
    pub anchor_template: Option<String>,
}

/// A citation found in text: the resolved id, optional anchor, byte offset, and the matched text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Citation {
    pub id: String,
    pub anchor: Option<String>,
    pub offset: usize,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct Resolver {
    patterns: Vec<CitePattern>,
    /// `part N` -> `<prefix>N` for base sources.
    part_patterns: Vec<(Regex, String)>,
}

fn fill(template: &str, caps: &regex::Captures, re: &Regex) -> String {
    let mut out = template.to_string();
    for name in re.capture_names().flatten() {
        let val = caps.name(name).map(|m| m.as_str()).unwrap_or("");
        out = out.replace(&format!("{{{name}}}"), val);
    }
    out
}

impl Resolver {
    pub fn new(sources: &BTreeMap<String, SourceConfig>) -> Resolver {
        let mut r = Resolver::default();
        for s in sources.values() {
            if let (Some(p), Some(t)) = (&s.id_pattern, &s.id_template) {
                if let Ok(regex) = Regex::new(p) {
                    r.patterns.push(CitePattern { source: s.name.clone(), regex, id_template: t.clone(), anchor_template: s.anchor_template.clone() });
                }
            }
            if s.is_base() && !s.id_prefix.is_empty() {
                if let Ok(re) = Regex::new(r"\b[Pp]art\s+(\d{1,4})\b") {
                    r.part_patterns.push((re, s.id_prefix.clone()));
                }
            }
        }
        r
    }

    fn citation_from(&self, p: &CitePattern, caps: &regex::Captures) -> Citation {
        let id = fill(&p.id_template, caps, &p.regex);
        let anchor = p.anchor_template.as_ref().map(|t| {
            let a = fill(t, caps, &p.regex);
            let a = a.trim_matches('-').to_string();
            let mut collapsed = String::new();
            let mut dash = false;
            for c in a.chars() {
                if c == '-' {
                    if !dash {
                        collapsed.push('-');
                    }
                    dash = true;
                } else {
                    collapsed.push(c);
                    dash = false;
                }
            }
            collapsed
        });
        let m = caps.get(0).unwrap();
        Citation { id, anchor: anchor.filter(|a| !a.is_empty()), offset: m.start(), text: m.as_str().to_string() }
    }

    /// First citation in `text`, if any (the query-side short-circuit).
    pub fn resolve(&self, text: &str) -> Option<Citation> {
        for p in &self.patterns {
            if let Some(caps) = p.regex.captures(text) {
                return Some(self.citation_from(p, &caps));
            }
        }
        None
    }

    /// Every citation in `text`, in order of appearance (the prose xref extractor).
    pub fn find_all(&self, text: &str) -> Vec<Citation> {
        let mut out: Vec<Citation> = Vec::new();
        for p in &self.patterns {
            for caps in p.regex.captures_iter(text) {
                out.push(self.citation_from(p, &caps));
            }
        }
        for (re, prefix) in &self.part_patterns {
            for caps in re.captures_iter(text) {
                let m = caps.get(0).unwrap();
                out.push(Citation { id: format!("{prefix}{}", &caps[1]), anchor: None, offset: m.start(), text: m.as_str().to_string() });
            }
        }
        out.sort_by_key(|c| c.offset);
        out.dedup_by(|a, b| a.offset == b.offset && a.id == b.id);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> BTreeMap<String, SourceConfig> {
        let mut m = BTreeMap::new();
        m.insert(
            "cfr-title-99".into(),
            SourceConfig {
                name: "cfr-title-99".into(),
                kind: "base".into(),
                id_prefix: "CFR:99-".into(),
                id_pattern: Some(r"(?i)(?:99\s*C\.?F\.?R\.?\s*(?:§\s*)?|§\s*|\bsection\s+)(?P<part>[1-3])\.(?P<section>\d{1,2})(?:\s*\((?P<p1>[a-z]|\d{1,2}|[ivx]{1,4})\))?(?:\s*\((?P<p2>[a-z]|\d{1,2}|[ivx]{1,4})\))?".into()),
                id_template: Some("CFR:99-{part}.{section}".into()),
                anchor_template: Some("{p1}-{p2}".into()),
                ..Default::default()
            },
        );
        m
    }

    #[test]
    fn resolves_citation_shapes() {
        let r = Resolver::new(&sources());
        assert_eq!(r.resolve("99 CFR 2.8").map(|c| c.id), Some("CFR:99-2.8".into()));
        let c = r.resolve("see § 1.5(a)(2) please").unwrap();
        assert_eq!((c.id.as_str(), c.anchor.as_deref()), ("CFR:99-1.5", Some("a-2")));
        let c = r.resolve("section 2.13(c)").unwrap();
        assert_eq!(c.anchor.as_deref(), Some("c"));
        assert!(r.resolve("nothing here").is_none());
        let all = r.find_all("Paragraphs (e) and (f) of § 2.8 of Title 99 and part 2 apply; see 99 C.F.R. § 3.9.");
        let ids: Vec<&str> = all.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["CFR:99-2.8", "CFR:99-2", "CFR:99-3.9"]);
    }
}
