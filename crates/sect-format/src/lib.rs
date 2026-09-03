//! Rendering. Text output starts with the two header lines; JSON output has `freshness` and
//! `counts` as its first keys, then `result`.

use sect_core::{Freshness, Response};
use sect_corpus::Level;
use sect_index::BuildReport;
use sect_query::{DefineResult, MapResult, ReadResult, RefsResult, StatusResult};
use sect_struct::{Direction, HistoryEntry};
use serde::Serialize;

pub fn json<T: Serialize>(r: &Response<T>) -> String {
    serde_json::to_string_pretty(r).unwrap_or_else(|e| format!("{{\"error\": \"{e}\"}}"))
}

/// Pretty JSON of any serializable value (used for the `sect index --json` report).
pub fn json_value<T: Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|e| format!("{{\"error\": \"{e}\"}}"))
}

fn header<T: Serialize>(r: &Response<T>) -> String {
    let [f, c] = r.header.lines();
    format!("{f}\n{c}\n")
}

fn date(d: &Option<chrono::NaiveDate>) -> String {
    d.map(|d| d.to_string()).unwrap_or_else(|| "n/a".into())
}

pub fn read_text(r: &Response<ReadResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    let anchor = x.anchor.as_ref().map(|a| format!("#{a}")).unwrap_or_default();
    s.push_str(&format!("{}{anchor}  {}\n", x.expr, x.breadcrumb));
    let mut meta = vec![format!("effective {}", date(&x.effective))];
    if let Some(d) = x.as_of {
        meta.push(format!("as-of {d} (snapped)"));
    }
    if let Some(p) = &x.supersedes {
        meta.push(format!("supersedes {p}"));
    }
    if let Some(p) = &x.superseded_by {
        meta.push(format!("superseded-by {p}"));
    }
    if !x.amended_by.is_empty() {
        meta.push(format!("amended-by {}", x.amended_by.join(", ")));
    }
    meta.push(format!("source {} ({})", x.source, x.legal_status));
    if x.expressions > 1 {
        meta.push(format!("{} expressions", x.expressions));
    }
    s.push_str(&meta.join("; "));
    s.push('\n');
    if !x.overridden_by.is_empty() {
        s.push_str(&format!("overridden-by: {}\n", x.overridden_by.join(", ")));
    }
    for n in &x.narrowed_by {
        s.push_str(&format!("narrowed-by: {} at #{}\n", n.id, n.anchor.clone().unwrap_or_default()));
    }
    s.push_str(&format!("path {}\n", x.path));
    if !x.ancestors.is_empty() {
        s.push_str("ancestors: ");
        s.push_str(&x.ancestors.iter().rev().map(|a| format!("{} {} [{}]", a.label, a.title, a.id)).collect::<Vec<_>>().join(" > "));
        s.push('\n');
    }
    if !x.children.is_empty() {
        s.push_str("children:\n");
        for c in &x.children {
            s.push_str(&format!("  {} {} [{}]\n", c.label, c.title, c.id));
        }
    }
    if !x.history.is_empty() {
        s.push_str("history:\n");
        for h in &x.history {
            match h {
                HistoryEntry::Expression { id, effective, supersedes, superseded_by, citation, .. } => {
                    let mut bits = vec![format!("effective {}", date(effective))];
                    if let Some(p) = supersedes {
                        bits.push(format!("supersedes {p}"));
                    }
                    if let Some(p) = superseded_by {
                        bits.push(format!("superseded-by {p}"));
                    }
                    if let Some(c) = citation {
                        bits.push(c.clone());
                    }
                    s.push_str(&format!("  expression {id}  {}\n", bits.join("; ")));
                }
                HistoryEntry::Action { id, notice, effective, action, target_anchor, .. } => {
                    let a = target_anchor.as_ref().map(|a| format!(" at #{a}")).unwrap_or_default();
                    s.push_str(&format!("  action     {id}  {action}{a}; effective {}; notice {notice}\n", date(effective)));
                }
            }
        }
    }
    if !x.tables.is_empty() {
        s.push_str(&format!("tables: {}\n", x.tables.len()));
        for t in &x.tables {
            s.push_str(&format!("  table {} at line {}: | {} |\n", t.index + 1, t.line, t.header.join(" | ")));
            for row in &t.flat_rows {
                s.push_str(&format!("    {row}\n"));
            }
        }
    }
    s.push('\n');
    s.push_str(&x.body);
    s.push('\n');
    s
}

pub fn map_text(r: &Response<MapResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    if x.complete {
        s.push_str(&format!("complete subtree of {}: {} item(s) by traversal\n", x.scope.clone().unwrap_or_default(), x.total));
    }
    for e in &x.entries {
        let indent = "  ".repeat(e.depth);
        let flags = if e.flags.is_empty() { String::new() } else { format!("  [{}]", e.flags.join("; ")) };
        match &e.anchor {
            Some(a) => s.push_str(&format!("{indent}#{a}{flags}\n")),
            None => {
                let kids = if e.children > 0 { format!(" ({} children)", e.children) } else { String::new() };
                s.push_str(&format!("{indent}{} {} [{}]{kids}{flags}\n", e.label, e.title, e.id));
            }
        }
    }
    if x.truncated {
        s.push_str(&format!("... truncated at budget {} tokens ({} of {} entries shown); narrow with --scope, raise --budget, or use --complete\n", x.budget, x.entries.len(), x.total));
    }
    s
}

pub fn refs_text(r: &Response<RefsResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    let dir = match x.direction {
        Direction::In => "in",
        Direction::Out => "out",
        Direction::Both => "both",
    };
    s.push_str(&format!("refs of {} direction {dir} type {} depth {}{}\n", x.id, x.kind.clone().unwrap_or_else(|| "any".into()), x.depth, x.as_of.map(|d| format!(" as-of {d}")).unwrap_or_default()));
    for h in &x.hits {
        let anchor = h.edge.anchor.as_ref().map(|a| format!("#{a}")).unwrap_or_default();
        let line = h.edge.line.map(|l| format!(" line {l}")).unwrap_or_default();
        let via = match h.edge.via {
            sect_corpus::Via::Link => "link",
            sect_corpus::Via::Prose => "prose",
            sect_corpus::Via::FrontMatter => "front-matter",
        };
        let unresolved = if h.edge.resolved { "" } else { "  UNRESOLVED" };
        s.push_str(&format!("{}  {:<10} {} -> {}{anchor}  via {via}{line}  ({}){unresolved}\n", h.depth, h.edge.kind, h.edge.from_expr, h.edge.to, h.other_title));
    }
    s
}

pub fn define_text(r: &Response<DefineResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    if !x.defined {
        s.push_str(&format!("not defined: `{}`{}", x.term, x.as_of.map(|d| format!(" as of {d}")).unwrap_or_default()));
        if !x.nearest.is_empty() {
            s.push_str(&format!("; nearest defined terms: {}", x.nearest.join(", ")));
        }
        s.push('\n');
        return s;
    }
    s.push_str(&format!("{} defined in {}#{} ({}) line {}\n", x.term, x.id.clone().unwrap_or_default(), x.anchor.clone().unwrap_or_default(), x.breadcrumb.clone().unwrap_or_default(), x.line.unwrap_or(0)));
    s.push_str(&format!("{}\n", x.definition.clone().unwrap_or_default()));
    if x.scope.is_some() || !x.usages.is_empty() {
        s.push_str(&format!("usages{}: {}\n", x.scope.as_ref().map(|sc| format!(" within {sc}")).unwrap_or_default(), x.usages.len()));
        for u in &x.usages {
            s.push_str(&format!("  {} {} [{}]  x{}\n", u.label, u.title, u.id, u.count));
        }
    }
    s
}

pub fn status_text(r: &Response<StatusResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    s.push_str(&format!("corpus: {}\nindex: {}\nbuilt: {} by sect {} (schema {}) in {} ms\n", x.corpus_root, x.index_dir, x.built_at, x.sect_version, x.schema_version, x.build_ms));
    s.push_str(&format!("files: {}; works: {}; expressions: {} ({} superseded)\n", x.files, x.works, x.expressions, x.superseded));
    s.push_str(&format!("structure: {} edges, {} actions, {} terms, {} tables\n", x.edges, x.actions, x.terms, x.tables));
    s.push_str("sources:\n");
    for src in &x.sources {
        s.push_str(&format!("  {:<18} kind {:<8} precedence {:<4} legal-status {:<15} files {}\n", src.name, src.kind, src.precedence, src.legal_status, src.files));
    }
    s.push_str("legal-status of works: ");
    s.push_str(&x.legal_status.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", "));
    s.push('\n');
    s.push_str("layers: ");
    s.push_str(&x.layers.iter().map(|(k, v)| format!("{k} {}", if *v { "yes" } else { "no" })).collect::<Vec<_>>().join(", "));
    s.push('\n');
    s.push_str(&format!("unresolved refs: {}\n", x.unresolved_refs));
    for e in &x.unresolved {
        s.push_str(&format!("  unresolved {} -> {}{} ({})\n", e.from_expr, e.to, e.anchor.as_ref().map(|a| format!("#{a}")).unwrap_or_default(), e.kind));
    }
    s.push_str(&format!("warnings: {}\n", x.warnings.len()));
    for w in &x.warnings {
        s.push_str(&format!("  warning {}: {}\n", w.path, w.message));
    }
    s
}

/// `sect index` report. Header first, then every issue, then a summary line.
pub fn build_text(rep: &BuildReport) -> String {
    let freshness = if rep.validate_only {
        "freshness: validate-only (index not written)".to_string()
    } else if rep.written {
        Freshness::Fresh { files: rep.files, built_at: "now".into(), rebuilt: Some(rep.changed) }.line()
    } else {
        format!("freshness: not written ({} error(s) block the index; fix them or see --validate-only)", rep.errors())
    };
    let mut s = format!(
        "{freshness}\ncounts: {} files, {} works, {} expressions ({} superseded), {} sources; {} changed; errors {}, warnings {}\n",
        rep.files, rep.works, rep.expressions, rep.superseded, rep.sources, rep.changed, rep.errors(), rep.warnings()
    );
    s.push_str(&format!("structure: {} edges, {} actions, {} terms, {} tables; {} unresolved refs\n", rep.edges, rep.actions, rep.terms, rep.tables, rep.unresolved_refs));
    for i in &rep.issues {
        let lvl = match i.level {
            Level::Error => "error",
            Level::Warning => "warning",
        };
        s.push_str(&format!("{lvl}: {}: {}\n", i.path, i.message));
    }
    s.push_str(&format!(
        "{} {} files in {} ms\n",
        if rep.validate_only { "validated" } else if rep.written { "indexed" } else { "checked" },
        rep.files,
        rep.elapsed_ms
    ));
    s
}
