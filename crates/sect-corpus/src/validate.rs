//! Contract check for the spec B.2 corpus layout (`sect index --validate-only`). Errors block an
//! index build; warnings are reported through `status`.

use std::collections::{BTreeMap, HashMap, HashSet};

use sect_core::{split_expr, Action, SourceConfig};
use serde::{Deserialize, Serialize};

use crate::document::{slug, Document};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Issue {
    pub level: Level,
    pub path: String,
    pub message: String,
}

const REQUIRED: &[&str] = &[
    "id",
    "source",
    "title",
    "parent",
    "order",
    "effective",
    "supersedes",
    "superseded_by",
    "amended_by",
    "overrides",
    "narrows",
    "defines",
    "context",
    "provenance",
];
const PROVENANCE: &[&str] = &[
    "raw",
    "raw_sha256",
    "locator",
    "legal_status",
    "ingest_run",
    "confidence",
    "verified_by",
];
const LEGAL: &[&str] = &["official", "unofficial-xml", "derived"];

struct Ctx<'a> {
    docs: &'a [Document],
    sources: &'a BTreeMap<String, SourceConfig>,
    by_id: HashMap<&'a str, Vec<&'a Document>>,
    by_expr: HashMap<String, &'a Document>,
    actions: HashMap<&'a str, (&'a Action, &'a Document)>,
    issues: Vec<Issue>,
}

impl<'a> Ctx<'a> {
    fn err(&mut self, d: &Document, msg: impl Into<String>) {
        self.issues.push(Issue {
            level: Level::Error,
            path: d.rel.clone(),
            message: msg.into(),
        });
    }
    fn warn(&mut self, d: &Document, msg: impl Into<String>) {
        self.issues.push(Issue {
            level: Level::Warning,
            path: d.rel.clone(),
            message: msg.into(),
        });
    }
    /// The current (non-superseded, latest) document of a Work.
    fn current(&self, id: &str) -> Option<&'a Document> {
        let docs = self.by_id.get(id)?;
        let mut live: Vec<&&Document> = docs
            .iter()
            .filter(|d| d.front.superseded_by.is_none())
            .collect();
        if live.is_empty() {
            live = docs.iter().collect();
        }
        live.sort_by_key(|d| d.front.effective);
        live.last().map(|d| **d)
    }
}

pub fn validate(docs: &[Document], sources: &BTreeMap<String, SourceConfig>) -> Vec<Issue> {
    let mut by_id: HashMap<&str, Vec<&Document>> = HashMap::new();
    let mut by_expr: HashMap<String, &Document> = HashMap::new();
    let mut actions: HashMap<&str, (&Action, &Document)> = HashMap::new();
    for d in docs {
        if let Some(id) = d.id() {
            by_id.entry(id).or_default().push(d);
        }
        if let Some(e) = d.expr() {
            by_expr.entry(e).or_insert(d);
        }
        for a in &d.front.actions {
            actions.insert(a.action_id.as_str(), (a, d));
        }
    }
    // A section's Expression is dated when its own text took effect (per-section dates from the
    // versioner); a link in it is read as of the corpus, so a target is active if it has an
    // Expression by the citing section's date or by the source's latest date.
    let mut latest: HashMap<&str, _> = HashMap::new();
    for d in docs {
        if let Some(e) = d.front.effective {
            let v = latest.entry(d.source.as_str()).or_insert(e);
            if e > *v {
                *v = e;
            }
        }
    }
    let mut cx = Ctx {
        docs,
        sources,
        by_id,
        by_expr,
        actions,
        issues: Vec::new(),
    };
    let mut seen_expr: HashSet<String> = HashSet::new();

    for d in cx.docs {
        let src = match cx.sources.get(&d.source) {
            Some(s) => s.clone(),
            None => {
                cx.err(d, format!("unknown source `{}`", d.source));
                continue;
            }
        };
        for k in REQUIRED {
            if !d.keys.contains(*k) {
                cx.err(d, format!("missing front matter key `{k}`"));
            }
        }
        let level = d.front.level.clone().unwrap_or_else(|| "section".into());
        let Some(id) = d.id().map(str::to_string) else {
            cx.err(d, "`id` is missing or empty");
            continue;
        };
        let root_id = src.id_prefix.trim_end_matches(['-', ':', '/']);
        if !(id.starts_with(&src.id_prefix) || level == "title" && id == root_id) {
            cx.err(
                d,
                format!(
                    "id `{id}` does not start with source prefix `{}`",
                    src.id_prefix
                ),
            );
        }
        if d.front.source.as_deref() != Some(d.source.as_str()) {
            cx.err(
                d,
                format!(
                    "`source` is `{}` but the file lives under source `{}`",
                    d.front.source.clone().unwrap_or_default(),
                    d.source
                ),
            );
        }
        match d.expr() {
            Some(e) if !seen_expr.insert(e.clone()) => {
                cx.err(d, format!("duplicate Expression `{e}`"))
            }
            _ => {}
        }
        if d.keys.contains("effective") && d.front.effective.is_none() {
            cx.err(d, "`effective` is missing or not a date (YYYY-MM-DD)");
        }
        match &d.front.parent {
            Some(p) if !cx.by_id.contains_key(p.as_str()) => {
                cx.err(d, format!("parent `{p}` does not resolve"))
            }
            None if d.keys.contains("parent") && src.is_base() && level != "title" => {
                cx.err(d, "base section without a parent")
            }
            _ => {}
        }
        let mut chain = HashSet::new();
        chain.insert(id.clone());
        let mut parent = d.front.parent.clone();
        while let Some(p) = parent {
            if !chain.insert(p.clone()) {
                cx.err(d, format!("parent cycle involving `{p}`"));
                break;
            }
            parent = cx
                .by_id
                .get(p.as_str())
                .and_then(|v| {
                    v.iter()
                        .filter(|p| p.front.effective <= d.front.effective)
                        .max_by_key(|p| p.front.effective)
                })
                .and_then(|p| p.front.parent.clone());
        }
        if d.keys.contains("provenance") {
            for k in PROVENANCE {
                if !d.provenance_keys.contains(*k) {
                    cx.err(d, format!("provenance missing `{k}`"));
                }
            }
            let ls = d
                .front
                .provenance
                .as_ref()
                .and_then(|p| p.legal_status.clone())
                .unwrap_or_default();
            if !LEGAL.contains(&ls.as_str()) {
                cx.err(
                    d,
                    format!("provenance.legal_status `{ls}` not in {LEGAL:?}"),
                );
            }
        }
        if let Some(s) = &d.front.supersedes {
            match cx.by_expr.get(s).copied() {
                None => cx.err(d, format!("supersedes `{s}` is not a known Expression")),
                Some(prev) => {
                    if prev.front.superseded_by.as_deref() != d.expr().as_deref() {
                        cx.err(
                            d,
                            format!(
                                "supersedes `{s}` but that Expression's superseded_by is `{}`",
                                prev.front.superseded_by.clone().unwrap_or("null".into())
                            ),
                        );
                    }
                }
            }
        }
        if let Some(s) = &d.front.superseded_by {
            if !cx.by_expr.contains_key(s) {
                cx.err(d, format!("superseded_by `{s}` is not a known Expression"));
            }
        }
        for a in &d.front.amended_by {
            match cx.actions.get(a.as_str()).copied() {
                None => cx.err(d, format!("amended_by `{a}` is not a known Action")),
                Some((act, _)) => {
                    // The target is this section, or a container above it: a part-wide word change
                    // amends every leaf under the part through the one Action.
                    let mut above = false;
                    let mut p = d.front.parent.clone();
                    let mut seen = HashSet::new();
                    while let Some(pid) = p {
                        if !seen.insert(pid.clone()) {
                            break;
                        }
                        if pid == act.target_id {
                            above = true;
                            break;
                        }
                        p = cx
                            .by_id
                            .get(pid.as_str())
                            .and_then(|v| {
                                v.iter()
                                    .filter(|ancestor| {
                                        d.front.effective.is_none()
                                            || ancestor.front.effective <= d.front.effective
                                    })
                                    .max_by_key(|ancestor| ancestor.front.effective)
                            })
                            .and_then(|x| x.front.parent.clone());
                    }
                    if act.target_id != id && !above {
                        cx.err(d, format!("Action `{a}` targets `{}`, not this section nor a container above it", act.target_id));
                    } else if let (Some(text), false) = (&act.text, act.kind == "remove") {
                        // A removal's quoted text is what leaves the Expression; it is not looked for.
                        // Quoted paragraphs are looked for one by one (an inserted one may sit between
                        // two others); a heading, a "reads as follows", or a paragraph printed with
                        // asterisks is not given whole and is skipped.
                        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
                        let body = norm(&d.body);
                        let missing = text
                            .split("\n\n")
                            .map(|p| p.trim())
                            .filter(|p| {
                                !p.is_empty()
                                    && !p.starts_with('#')
                                    && !p.contains("* * *")
                                    && !p.to_lowercase().ends_with("as follows:")
                                    && !p.to_lowercase().ends_with("as follows")
                            })
                            .filter(|p| p.split_whitespace().count() >= 4)
                            .filter(|p| !body.contains(&norm(p)))
                            .count();
                        if missing > 0 {
                            cx.err(d, format!("Action `{a}` quoted text is not present in this Expression ({missing} paragraph(s))"));
                        }
                    }
                }
            }
        }
        for t in &d.front.overrides {
            match cx.current(t) {
                None => cx.err(d, format!("overrides `{t}` does not resolve")),
                Some(tgt) => {
                    let ts = cx.sources.get(&tgt.source).cloned().unwrap_or_default();
                    if !ts.is_base() || ts.precedence >= src.precedence {
                        cx.err(
                            d,
                            format!("overrides `{t}` must be base-kind and lower precedence"),
                        );
                    }
                }
            }
        }
        for n in &d.front.narrows {
            match cx.current(&n.id) {
                None => cx.err(d, format!("narrows `{}` does not resolve", n.id)),
                Some(tgt) => {
                    let ts = cx.sources.get(&tgt.source).cloned().unwrap_or_default();
                    if !ts.is_base() || ts.precedence >= src.precedence {
                        cx.err(
                            d,
                            format!("narrows `{}` must be base-kind and lower precedence", n.id),
                        );
                    }
                    if let Some(a) = &n.anchor {
                        if !tgt.anchors().contains(a) {
                            cx.err(d, format!("narrows anchor `{a}` not found in `{}`", n.id));
                        }
                    }
                }
            }
        }
        let kind = d.front.kind.clone().unwrap_or_else(|| src.kind.clone());
        for l in &d.links {
            let Some(tgt) = cx.current(&l.target) else {
                if l.via == crate::document::Via::Prose {
                    cx.warn(
                        d,
                        format!(
                            "prose reference `{}` (line {}) does not resolve",
                            l.target, l.line
                        ),
                    );
                } else if !cx
                    .sources
                    .values()
                    .any(|s| !s.id_prefix.is_empty() && l.target.starts_with(&s.id_prefix))
                {
                    // A link into a title or standard this corpus does not hold (a notice that amends
                    // three CFR titles, say) is a warning: nothing here can check it.
                    cx.warn(
                        d,
                        format!(
                            "link target `{}` is outside this corpus's sources",
                            l.target
                        ),
                    );
                } else if kind == "notice" {
                    // A notice describes the text before its own amendments; a section it removes
                    // is gone from the post-amendment snapshot, which lint's Action integrity covers.
                    cx.warn(d, format!("notice link target `{}` does not resolve (amended text may no longer exist)", l.target));
                } else {
                    cx.err(d, format!("link target `{}` does not resolve", l.target));
                }
                continue;
            };
            if let Some(a) = &l.anchor {
                if !tgt.anchors().contains(a) {
                    if l.via == crate::document::Via::Prose {
                        cx.warn(
                            d,
                            format!(
                                "prose reference `{}#{a}` (line {}): anchor not found",
                                l.target, l.line
                            ),
                        );
                    } else {
                        cx.err(
                            d,
                            format!(
                                "link anchor `{}#{a}` not found (anchors: {})",
                                l.target,
                                tgt.anchors().join(", ")
                            ),
                        );
                    }
                }
            }
            // A notice links to the text it amends; with a snapshot-dated base (one effective date
            // per title) that target is dated after the notice, so activity is lint's question there.
            if kind == "notice" {
                continue;
            }
            if let (Some(eff), Some(_)) = (d.front.effective, tgt.front.effective) {
                let as_of = latest
                    .get(d.source.as_str())
                    .copied()
                    .map(|l| if l > eff { l } else { eff })
                    .unwrap_or(eff);
                let active = cx
                    .by_id
                    .get(l.target.as_str())
                    .map(|v| {
                        v.iter()
                            .any(|x| x.front.effective.map(|e| e <= as_of).unwrap_or(false))
                    })
                    .unwrap_or(false);
                if !active {
                    cx.err(d, format!("link target `{}` is not active at this section's effective date {eff} nor at the source's latest date {as_of}", l.target));
                }
            }
        }
        let body_low = d.body.to_lowercase();
        for term in &d.front.defines {
            if !body_low.contains(&term.to_lowercase()) {
                cx.err(
                    d,
                    format!("defined term `{term}` does not appear in the body"),
                );
            }
        }
        if d.front
            .context_kind
            .as_deref()
            .is_some_and(|k| !matches!(k, "navigation" | "summary"))
        {
            cx.err(d, "context_kind must be navigation or summary");
        }
        let n_ctx = d.front.context_text().split_whitespace().count();
        if d.front.context_kind.as_deref() != Some("navigation")
            && matches!(level.as_str(), "section" | "notice" | "note")
            && !(40..=110).contains(&n_ctx)
        {
            cx.warn(
                d,
                format!("context prefix is {n_ctx} words; spec asks for roughly 50-100 tokens"),
            );
        }
        let sim = jaccard(&d.front.context_text(), &d.body);
        if d.front.context_kind.as_deref() != Some("navigation") && sim >= 0.8 {
            cx.err(
                d,
                format!("context prefix paraphrases the body (similarity {sim:.2} >= 0.8)"),
            );
        }
        if kind == "notice" && d.front.actions.is_empty() {
            cx.err(d, "notice without Action records");
        }
        for a in &d.front.actions {
            if a.action_id.is_empty()
                || a.target_id.is_empty()
                || a.kind.is_empty()
                || a.effective.is_none()
                || a.text.is_none()
            {
                cx.err(
                    d,
                    "Action missing one of action_id, target_id, kind, effective, text",
                );
            }
            // Spec B.6 lists a missing Action target under lint: a `remove` names text the
            // post-amendment snapshot no longer holds, and a notice may amend titles not here.
            if !cx.by_id.contains_key(a.target_id.as_str()) {
                cx.warn(
                    d,
                    format!("Action target `{}` does not resolve", a.target_id),
                );
            }
        }
        let _ = split_expr(&id);
    }
    cx.issues
}

fn content_words(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() > 2)
        .map(|w| w.to_string())
        .collect()
}

fn jaccard(a: &str, b: &str) -> f64 {
    let (sa, sb) = (content_words(a), content_words(b));
    let inter = sa.intersection(&sb).count();
    let union = sa.union(&sb).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// Anchor slug helper re-exported for callers that build anchor lists.
pub fn term_anchor(term: &str) -> String {
    slug(term)
}
