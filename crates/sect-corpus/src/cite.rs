//! Citation-shaped text -> Work id, driven by each source's `id_pattern` / `id_template` /
//! `anchor_template` (spec B.3 citation short-circuit; spec-changes #1). Also the fallback
//! prose cross-reference extractor of spec B.4 ("§ 1.5", "99 CFR 1.5", "part 2").
//!
//! A bare citation (`§ 2.1`, `part 17`) resolves against the document's *home* base source (its
//! own title, or the title an overlay or notice amends). Citations into another base source must
//! be explicit (`4 CFR 2.1`), otherwise every title's pattern would claim the same `§ 2.1`.

use std::collections::BTreeMap;

use regex::Regex;
use sect_core::SourceConfig;

#[derive(Debug, Clone)]
pub struct CitePattern {
    pub source: String,
    pub is_base: bool,
    pub id_prefix: String,
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
    /// `part N` -> `<prefix>N`, per base source.
    part_patterns: Vec<(String, Regex, String)>,
}

fn fill(template: &str, caps: &regex::Captures, re: &Regex) -> String {
    let mut out = template.to_string();
    for name in re.capture_names().flatten() {
        let val = caps.name(name).map(|m| m.as_str()).unwrap_or("");
        out = out.replace(&format!("{{{name}}}"), val);
    }
    out
}

/// True when the matched text names its title explicitly ("4 CFR 2.1"), not a bare "§ 2.1".
fn is_explicit(text: &str) -> bool {
    let up = text.to_uppercase();
    up.contains("CFR") || up.contains("C.F.R")
}

impl Resolver {
    pub fn new(sources: &BTreeMap<String, SourceConfig>) -> Resolver {
        let mut r = Resolver::default();
        let part_regex = Regex::new(r"\b[Pp]arts?\s+(\d{1,4})\b").expect("part citation regex");
        for s in sources.values() {
            if let (Some(p), Some(t)) = (&s.id_pattern, &s.id_template) {
                if let Ok(regex) = Regex::new(p) {
                    r.patterns.push(CitePattern {
                        source: s.name.clone(),
                        is_base: s.is_base(),
                        id_prefix: s.id_prefix.clone(),
                        regex,
                        id_template: t.clone(),
                        anchor_template: s.anchor_template.clone(),
                    });
                }
            }
            if s.is_base() && !s.id_prefix.is_empty() {
                r.part_patterns
                    .push((s.name.clone(), part_regex.clone(), s.id_prefix.clone()));
            }
        }
        r
    }

    /// Names of the base sources with a citation pattern.
    pub fn base_sources(&self) -> Vec<&str> {
        self.patterns
            .iter()
            .filter(|p| p.is_base)
            .map(|p| p.source.as_str())
            .collect()
    }

    /// The home base source for a document: its own source when that is a base source, else the
    /// base source whose id prefix covers most of the document's link targets, else the only or
    /// first base source.
    pub fn home_source<'a>(&'a self, own_source: &str, link_targets: &[String]) -> Option<&'a str> {
        if self
            .patterns
            .iter()
            .any(|p| p.is_base && p.source == own_source)
        {
            return self
                .patterns
                .iter()
                .find(|p| p.is_base && p.source == own_source)
                .map(|p| p.source.as_str());
        }
        let mut best: Option<(&str, usize)> = None;
        for p in self.patterns.iter().filter(|p| p.is_base) {
            let n = link_targets
                .iter()
                .filter(|t| t.starts_with(&p.id_prefix))
                .count();
            if best.map(|(_, b)| n > b).unwrap_or(true) {
                best = Some((p.source.as_str(), n));
            }
        }
        best.map(|(s, _)| s)
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
        Citation {
            id,
            anchor: anchor.filter(|a| !a.is_empty()),
            offset: m.start(),
            text: m.as_str().to_string(),
        }
    }

    /// First citation in `text`, if any (the query-side short-circuit). Explicit forms win over
    /// bare ones so that "4 CFR 2.1" resolves to Title 4 even when Title 1 is also indexed.
    pub fn resolve(&self, text: &str) -> Option<Citation> {
        let mut bare: Option<Citation> = None;
        for p in &self.patterns {
            if let Some(caps) = p.regex.captures(text) {
                let c = self.citation_from(p, &caps);
                if is_explicit(&c.text) {
                    return Some(c);
                }
                if bare.is_none() {
                    bare = Some(c);
                }
            }
        }
        bare
    }

    /// Every citation in `text` for a document whose home base source is `home` (the prose xref
    /// extractor). Bare citations resolve against the home source only; other sources need the
    /// explicit form. `part N of title X` is another title and is skipped.
    pub fn find_all(&self, text: &str, home: Option<&str>) -> Vec<Citation> {
        let mut out: Vec<Citation> = Vec::new();
        for p in &self.patterns {
            let is_home = home
                .map(|h| h == p.source)
                .unwrap_or(!p.is_base || self.base_sources().len() == 1);
            for caps in p.regex.captures_iter(text) {
                let c = self.citation_from(p, &caps);
                if !is_home && !is_explicit(&c.text) {
                    continue;
                }
                out.push(c);
            }
        }
        // "20 CFR part 655" names another title before the part: not a bare citation of the home one.
        let other_title = Regex::new(r"(?i)(\d+)\s*C\.?F\.?R\.?$").unwrap();
        for (source, re, prefix) in &self.part_patterns {
            let is_home = home
                .map(|h| h == source)
                .unwrap_or(self.part_patterns.len() == 1);
            if !is_home {
                continue;
            }
            // The title number of this source, e.g. `99` from `CFR:99-`, to tell "part 2 of title 99"
            // (home) from "part 50 of title 5" (another title).
            let home_title: String = prefix.chars().filter(|c| c.is_ascii_digit()).collect();
            for caps in re.captures_iter(text) {
                let m = caps.get(0).unwrap();
                let before = text[..m.start()].trim_end();
                if let Some(t) = other_title.captures(before).and_then(|c| c.get(1)) {
                    if t.as_str() != home_title {
                        continue;
                    }
                }
                let after = text[m.end()..].trim_start().to_lowercase();
                if let Some(rest) = after
                    .strip_prefix("of title ")
                    .or_else(|| after.strip_prefix("of subtitle "))
                {
                    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if num.is_empty() || num != home_title {
                        continue;
                    }
                }
                out.push(Citation {
                    id: format!("{prefix}{}", &caps[1]),
                    anchor: None,
                    offset: m.start(),
                    text: m.as_str().to_string(),
                });
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

    fn cfr(title: u32) -> SourceConfig {
        SourceConfig {
            name: format!("cfr-title-{title}"),
            kind: "base".into(),
            id_prefix: format!("CFR:{title}-"),
            id_pattern: Some(format!(
                r"(?i)(?:\b{title}\s*C\.?F\.?R\.?\s*(?:§\s*)?|§\s*|\bsection\s+)(?P<part>\d{{1,3}})\.(?P<section>\d{{1,4}}[a-z]?)(?:\s*\((?P<p1>[a-z]|\d{{1,2}}|[ivx]{{1,4}})\))?(?:\s*\((?P<p2>[a-z]|\d{{1,2}}|[ivx]{{1,4}})\))?"
            )),
            id_template: Some(format!("CFR:{title}-{{part}}.{{section}}")),
            anchor_template: Some("{p1}-{p2}".into()),
            ..Default::default()
        }
    }

    fn sources() -> BTreeMap<String, SourceConfig> {
        let mut m = BTreeMap::new();
        m.insert("cfr-title-1".into(), cfr(1));
        m.insert("cfr-title-4".into(), cfr(4));
        m.insert(
            "city".into(),
            SourceConfig {
                name: "city".into(),
                kind: "overlay".into(),
                id_prefix: "CITY:".into(),
                id_pattern: Some(r"(?i)\b(?P<num>AM-\d{1,3})\b".into()),
                id_template: Some("CITY:{num}".into()),
                ..Default::default()
            },
        );
        m
    }

    #[test]
    fn resolves_citation_shapes_and_prefers_explicit_titles() {
        let r = Resolver::new(&sources());
        assert_eq!(
            r.resolve("4 CFR 2.1").map(|c| c.id),
            Some("CFR:4-2.1".into())
        );
        assert_eq!(
            r.resolve("1 C.F.R. § 2.1").map(|c| c.id),
            Some("CFR:1-2.1".into())
        );
        let c = r.resolve("see § 1.5(a)(2) please").unwrap();
        assert_eq!(
            (c.id.as_str(), c.anchor.as_deref()),
            ("CFR:1-1.5", Some("a-2"))
        );
        assert!(r.resolve("nothing here").is_none());
        assert_eq!(r.resolve("AM-2").map(|c| c.id), Some("CITY:AM-2".into()));
    }

    #[test]
    fn bare_citations_stay_in_the_home_title() {
        let r = Resolver::new(&sources());
        let text = "Paragraphs (e) and (f) of § 2.8 apply; see 4 CFR 2.1 and part 17 of this chapter, part 50 of title 5, and part 3 of title 1.";
        let ids: Vec<String> = r
            .find_all(text, Some("cfr-title-1"))
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["CFR:1-2.8", "CFR:4-2.1", "CFR:1-17", "CFR:1-3"]);
        // An overlay whose links point into Title 4 has Title 4 as its home.
        assert_eq!(
            r.home_source("city", &["CFR:4-2.8".into()]),
            Some("cfr-title-4")
        );
        assert_eq!(r.home_source("cfr-title-1", &[]), Some("cfr-title-1"));
        let ids: Vec<String> = r
            .find_all(
                "§ 2.8 of Title 4",
                r.home_source("city", &["CFR:4-2.8".into()]),
            )
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["CFR:4-2.8"]);
    }
}
