//! Rendering. Text output starts with the two header lines; JSON output has `freshness` and
//! `counts` as its first keys, then `result`.

use sect_core::{Freshness, Response};
use sect_corpus::Level;
use sect_index::BuildReport;
use sect_query::{MapResult, ReadResult, StatusResult};
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

pub fn read_text(r: &Response<ReadResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    s.push_str(&format!("{}  {}\n", x.expr, x.breadcrumb));
    let mut meta = vec![format!("effective {}", x.effective.map(|d| d.to_string()).unwrap_or_else(|| "n/a".into()))];
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
    s.push('\n');
    s.push_str(&x.body);
    s.push('\n');
    s
}

pub fn map_text(r: &Response<MapResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    for e in &x.entries {
        let indent = "  ".repeat(e.depth);
        let flags = if e.flags.is_empty() { String::new() } else { format!("  [{}]", e.flags.join("; ")) };
        let kids = if e.children > 0 { format!(" ({} children)", e.children) } else { String::new() };
        s.push_str(&format!("{indent}{} {} [{}]{kids}{flags}\n", e.label, e.title, e.id));
    }
    if x.truncated {
        s.push_str(&format!(
            "... truncated at budget {} tokens ({} of {} entries shown); narrow with --scope or raise --budget\n",
            x.budget, x.entries.len(), x.total
        ));
    }
    s
}

pub fn status_text(r: &Response<StatusResult>) -> String {
    let x = &r.result;
    let mut s = header(r);
    s.push_str(&format!("corpus: {}\nindex: {}\nbuilt: {} by sect {} (schema {}) in {} ms\n", x.corpus_root, x.index_dir, x.built_at, x.sect_version, x.schema_version, x.build_ms));
    s.push_str(&format!("files: {}; works: {}; expressions: {} ({} superseded)\n", x.files, x.works, x.expressions, x.superseded));
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
    s.push_str(&format!("unresolved refs: {}\nwarnings: {}\n", x.unresolved_refs, x.warnings.len()));
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
