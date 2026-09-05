//! Exact-match tests of the structural verbs (refs, define, as-of, map --complete, history)
//! against the E.1 question set in eval/questions (spec E.1: exact-match for these verbs).

use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use sect_query::ReadOptions;
use sect_struct::Direction;
use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == ".sect" {
            continue;
        }
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).unwrap();
        }
    }
}

fn questions(name: &str) -> Vec<Value> {
    let text = fs::read_to_string(repo().join("eval/questions").join(name)).unwrap();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn strs(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

fn date(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

struct Tally {
    ok: usize,
    fail: Vec<String>,
    skipped: usize,
}

impl Tally {
    fn new() -> Self {
        Tally {
            ok: 0,
            fail: vec![],
            skipped: 0,
        }
    }
    fn check(&mut self, qid: &str, ok: bool, detail: String) {
        if ok {
            self.ok += 1;
        } else {
            self.fail.push(format!("{qid}: {detail}"));
        }
    }
    fn assert_clean(&self, verb: &str) {
        assert!(
            self.fail.is_empty(),
            "{verb}: {} of {} failed:\n{}",
            self.fail.len(),
            self.ok + self.fail.len(),
            self.fail.join("\n")
        );
        assert!(self.ok > 0, "{verb}: no questions evaluated");
        eprintln!(
            "{verb}: exact-match {}/{} (skipped {})",
            self.ok,
            self.ok + self.fail.len(),
            self.skipped
        );
    }
}

#[test]
fn structural_verbs_match_the_question_set_exactly() {
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&repo().join("fixtures/corpus"), tmp.path());
    let index = sect_index::open(tmp.path(), sect_core::Refresh::Auto).unwrap();
    assert_eq!(
        index.manifest.unresolved_refs, 0,
        "unresolved: {:?}",
        index.manifest.unresolved
    );

    // map --complete (subtree-completeness)
    let mut t = Tally::new();
    for q in questions("subtree.jsonl") {
        let exp = &q["expected"];
        let scope = match exp["anchor"].as_str() {
            Some(a) => format!("{}#{a}", exp["id"].as_str().unwrap()),
            None => exp["id"].as_str().unwrap().to_string(),
        };
        let r = sect_query::map(&index, Some(&scope), 0, 0, true).unwrap();
        let got: Vec<String> = r
            .result
            .entries
            .iter()
            .map(|e| e.anchor.clone().unwrap_or_else(|| e.id.clone()))
            .collect();
        let want: Vec<String> = exp["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        t.check(
            q["qid"].as_str().unwrap(),
            got == want,
            format!("got {got:?} want {want:?}"),
        );
    }
    t.assert_clean("map --complete");

    // as-of (read --as-of snapping)
    let mut t = Tally::new();
    for q in questions("as-of.jsonl") {
        let exp = &q["expected"];
        match exp["op"].as_str().unwrap() {
            "as_of" => {
                let opts = ReadOptions {
                    as_of: Some(date(exp["date"].as_str().unwrap())),
                    ..Default::default()
                };
                let got = sect_query::read(&index, exp["id"].as_str().unwrap(), &opts)
                    .ok()
                    .map(|r| r.result.expr);
                let want = exp["expected"].as_str().map(str::to_string);
                t.check(
                    q["qid"].as_str().unwrap(),
                    got == want,
                    format!("got {got:?} want {want:?}"),
                );
            }
            _ => t.skipped += 1, // as_of_search needs `search` (milestone 4)
        }
    }
    t.assert_clean("read --as-of");

    // amendment history and amends edges
    let mut t = Tally::new();
    for q in questions("amendment-history.jsonl") {
        let exp = &q["expected"];
        match exp["op"].as_str() {
            Some("history") => {
                let got: Vec<String> =
                    sect_struct::history(&index.tree, &index.graph, exp["id"].as_str().unwrap())
                        .iter()
                        .map(|h| h.id().to_string())
                        .collect();
                let want: Vec<String> = exp["expected"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_string())
                    .collect();
                t.check(
                    q["qid"].as_str().unwrap(),
                    got == want,
                    format!("got {got:?} want {want:?}"),
                );
            }
            Some("refs") => check_refs(&index, &q, &mut t),
            _ => t.skipped += 1,
        }
    }
    t.assert_clean("read --history");

    // refs
    let mut t = Tally::new();
    for q in questions("refs.jsonl") {
        check_refs(&index, &q, &mut t);
    }
    t.assert_clean("refs");

    // define
    let mut t = Tally::new();
    for q in questions("define.jsonl") {
        let exp = &q["expected"];
        let term = exp["term"].as_str().unwrap();
        let scope = q["scope"].as_str();
        let r = sect_query::define(&index, term, true, scope, None).unwrap();
        let want = exp["expected"].as_array().unwrap();
        let ok_def = r.result.defined
            && r.result.id.as_deref() == want[0].as_str()
            && r.result.anchor.as_deref() == want[1].as_str();
        let mut ok = ok_def;
        let mut detail = format!(
            "got ({:?}, {:?}) want {want:?}",
            r.result.id, r.result.anchor
        );
        if let Some(u) = q.get("usages") {
            let got: Vec<String> = {
                let mut g: Vec<String> = r.result.usages.iter().map(|x| x.id.clone()).collect();
                g.sort();
                g
            };
            let wantu = strs(u);
            ok = ok && got == wantu;
            detail.push_str(&format!("; usages got {got:?} want {wantu:?}"));
        }
        t.check(q["qid"].as_str().unwrap(), ok, detail);
    }
    t.assert_clean("define");

    // Requested depths are reported exactly; this fixture's reachable graph ends before five.
    let a = sect_query::refs(
        &index,
        "CFR:99-2.7",
        Direction::In,
        Some("references"),
        9,
        None,
        false,
    )
    .unwrap();
    let b = sect_query::refs(
        &index,
        "CFR:99-2.7",
        Direction::In,
        Some("references"),
        5,
        None,
        false,
    )
    .unwrap();
    assert_eq!(a.result.depth, 9);
    assert_eq!(a.result.hits.len(), b.result.hits.len());
}

fn check_refs(index: &sect_index::Index, q: &Value, t: &mut Tally) {
    let exp = &q["expected"];
    let dir = Direction::parse(exp["direction"].as_str().unwrap_or("out")).unwrap();
    let as_of = exp["as_of"].as_str().map(date);
    let r = sect_query::refs(
        index,
        exp["id"].as_str().unwrap(),
        dir,
        exp["type"].as_str(),
        exp["depth"].as_u64().unwrap_or(1) as usize,
        as_of,
        false,
    )
    .unwrap();
    let mut got: Vec<String> = r.result.hits.iter().map(|h| h.other.clone()).collect();
    got.sort();
    got.dedup();
    let want = strs(&exp["expected"]);
    t.check(
        q["qid"].as_str().unwrap(),
        got == want,
        format!("got {got:?} want {want:?}"),
    );
}

#[test]
fn read_shows_overlay_markers_inline_and_slices_anchors() {
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&repo().join("fixtures/corpus"), tmp.path());
    let index = sect_index::open(tmp.path(), sect_core::Refresh::Auto).unwrap();
    let r = sect_query::read(&index, "CFR:99-1.4", &ReadOptions::default()).unwrap();
    let body = r.result.body;
    let marker_line = body
        .lines()
        .position(|l| l.starts_with("> narrowed-by CITY:AM-2#b"))
        .expect("marker present");
    assert!(
        body.lines()
            .nth(marker_line + 1)
            .unwrap()
            .starts_with("(b) *Training.*"),
        "marker sits right before paragraph (b)"
    );
    let r = sect_query::read(&index, "CFR:99-2.8", &ReadOptions::default()).unwrap();
    assert!(
        r.result
            .body
            .lines()
            .nth(1)
            .unwrap()
            .starts_with("> overridden-by CITY:AM-1 (effective 2025-03-01)"),
        "{}",
        r.result.body
    );
    let r = sect_query::read(&index, "CFR:99-1.5#a-2", &ReadOptions::default()).unwrap();
    assert!(
        r.result.body.starts_with("(2) An agricultural operation"),
        "{}",
        r.result.body
    );
    assert!(!r.result.body.contains("(3) A mining operation"));
    let r = sect_query::read(
        &index,
        "CFR:99-2.9",
        &ReadOptions {
            tables: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.result.tables.len(), 1);
    assert!(r.result.tables[0].flat_rows.iter().any(|x| x == "Occupancy: Heavy manufacturing; Minimum design live load: 250 pounds per square foot (12.0 kPa)"));
    let r = sect_query::read(
        &index,
        "CFR:99-2.7",
        &ReadOptions {
            history: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.result.history.len(), 3);
    assert!(sect_query::read(
        &index,
        "CFR:99-2.7",
        &ReadOptions {
            as_of: Some(date("2023-06-01")),
            ..Default::default()
        }
    )
    .is_err());
}
