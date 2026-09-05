//! End-to-end tests of the `sect` binary against a copy of the fixture corpus.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/corpus")
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if name == ".sect" {
            continue;
        }
        let to = dst.join(&name);
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).unwrap();
        }
    }
}

fn corpus_copy() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fixture(), tmp.path());
    tmp
}

fn sect(corpus: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_sect"))
        .arg("--corpus")
        .arg(corpus)
        .args(args)
        .output()
        .unwrap()
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).to_string()
}

#[test]
fn index_builds_the_structural_files() {
    let tmp = corpus_copy();
    let out = sect(tmp.path(), &["index"]);
    assert!(
        out.status.success(),
        "{}{}",
        stdout(&out),
        String::from_utf8_lossy(&out.stderr)
    );
    let text = stdout(&out);
    assert!(text.starts_with("freshness: fresh"), "{text}");
    assert!(
        text.lines()
            .nth(1)
            .unwrap()
            .starts_with("counts: 44 files, 43 works, 44 expressions (1 superseded), 4 sources"),
        "{text}"
    );
    for f in [
        "manifest.json",
        "fingerprints.json",
        "tree.json",
        "log.jsonl",
    ] {
        assert!(
            sect_index::index_dir(tmp.path()).join(f).is_file(),
            "missing .sect/{f}"
        );
    }
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(sect_index::index_dir(tmp.path()).join("manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["works"], 43);
    assert_eq!(manifest["layers"]["structural"], true);
    let tree: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(sect_index::index_dir(tmp.path()).join("tree.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        tree["nodes"]["CFR:99-2.7"]["current"],
        "CFR:99-2.7@2026-01-01"
    );
    assert_eq!(tree["nodes"]["CFR:99-2.8"]["overridden_by"][0], "CITY:AM-1");
    assert_eq!(
        tree["nodes"]["CFR:99-2"]["children"]
            .as_array()
            .unwrap()
            .len(),
        14
    );
}

#[test]
fn every_verb_starts_with_freshness_and_counts() {
    let tmp = corpus_copy();
    assert!(sect(tmp.path(), &["index"]).status.success());
    for args in [
        vec!["read", "CFR:99-2.7"],
        vec!["map", "--scope", "CFR:99-2"],
        vec!["map"],
        vec!["status"],
    ] {
        let out = sect(tmp.path(), &args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = stdout(&out);
        let mut lines = text.lines();
        assert!(
            lines.next().unwrap().starts_with("freshness: fresh"),
            "{args:?}: {text}"
        );
        assert!(
            lines.next().unwrap().starts_with("counts: "),
            "{args:?}: {text}"
        );
        let json = stdout(&sect(tmp.path(), &[&args[..], &["--json"]].concat()));
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v.get("result").is_some());
        // Key order in the emitted text: freshness, then counts, then result.
        assert!(
            json.trim_start().starts_with("{\n  \"freshness\""),
            "{args:?}: {json}"
        );
        assert!(
            json.find("\"counts\"").unwrap() < json.find("\"result\"").unwrap(),
            "{args:?}"
        );
    }
}

#[test]
fn read_resolves_current_and_dated_expressions() {
    let tmp = corpus_copy();
    let cur = stdout(&sect(tmp.path(), &["read", "CFR:99-2.7"]));
    assert!(cur.contains("CFR:99-2.7@2026-01-01"), "{cur}");
    assert!(cur.contains("supersedes CFR:99-2.7@2024-01-01"), "{cur}");
    assert!(cur.contains("amended-by FR:2026-00001#instr-1"), "{cur}");
    assert!(cur.contains("December 31, 2036"), "{cur}");
    let old = stdout(&sect(tmp.path(), &["read", "CFR:99-2.7@2024-01-01"]));
    assert!(old.contains("superseded-by CFR:99-2.7@2026-01-01"), "{old}");
    assert!(old.contains("for the life of the ladder"), "{old}");
    let g = stdout(&sect(tmp.path(), &["read", "CFR:99-2.8", "--ancestors"]));
    assert!(g.contains("overridden-by: CITY:AM-1"), "{g}");
    assert!(g.contains("ancestors: Title 99"), "{g}");
    let missing = sect(tmp.path(), &["read", "CFR:99-9.9"]);
    assert!(!missing.status.success());
}

#[test]
fn map_is_bounded_by_budget_and_scope() {
    let tmp = corpus_copy();
    let all = stdout(&sect(tmp.path(), &["map", "--depth", "5"]));
    assert!(all.contains("§ 3.9 Definitions [CFR:99-3.9]"), "{all}");
    assert!(all.contains("AM-1 "), "{all}");
    let small = stdout(&sect(
        tmp.path(),
        &["map", "--depth", "5", "--budget", "40"],
    ));
    assert!(small.contains("truncated at budget 40"), "{small}");
    let part = stdout(&sect(
        tmp.path(),
        &["map", "--scope", "CFR:99-3", "--depth", "1"],
    ));
    assert_eq!(
        part.lines().filter(|l| l.contains("[CFR:99-3.")).count(),
        9,
        "{part}"
    );
    let p2 = stdout(&sect(
        tmp.path(),
        &["map", "--scope", "CFR:99-2", "--depth", "1"],
    ));
    assert!(
        p2.contains("[CFR:99-2.8]  [overridden-by CITY:AM-1]"),
        "{p2}"
    );
    assert!(p2.contains("[CFR:99-2.7]  [2 expressions]"), "{p2}");
}

#[test]
fn validate_only_rejects_missing_id_and_missing_parent() {
    let tmp = corpus_copy();
    let file = tmp.path().join("cfr-title-99/I/A/2/2.8/99-2.8.md");
    let original = fs::read_to_string(&file).unwrap();

    let without_id: String = original
        .lines()
        .filter(|l| !l.starts_with("id:"))
        .map(|l| format!("{l}\n"))
        .collect();
    fs::write(&file, without_id).unwrap();
    let out = sect(tmp.path(), &["index", "--validate-only"]);
    assert_eq!(out.status.code(), Some(1), "{}", stdout(&out));
    let text = stdout(&out);
    assert!(text.starts_with("freshness: validate-only"), "{text}");
    assert!(
        text.contains("99-2.8.md: missing front matter key `id`"),
        "{text}"
    );
    assert!(
        !tmp.path().join(".sect").exists(),
        "validate-only must not write the index"
    );

    let without_parent: String = original
        .lines()
        .filter(|l| !l.starts_with("parent:"))
        .map(|l| format!("{l}\n"))
        .collect();
    fs::write(&file, without_parent).unwrap();
    let out = sect(tmp.path(), &["index", "--validate-only"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stdout(&out).contains("missing front matter key `parent`"),
        "{}",
        stdout(&out)
    );

    fs::write(&file, &original).unwrap();
    let ok = sect(tmp.path(), &["index", "--validate-only"]);
    assert!(ok.status.success(), "{}", stdout(&ok));
    assert!(stdout(&ok).contains("errors 0"));
}

#[test]
fn errors_block_the_index_build() {
    let tmp = corpus_copy();
    let file = tmp.path().join("cfr-title-99/I/A/1/1.3/99-1.3.md");
    let broken = fs::read_to_string(&file)
        .unwrap()
        .replace("(CFR:99-3.4)", "(CFR:99-3.44)");
    fs::write(&file, broken).unwrap();
    let out = sect(tmp.path(), &["index"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stdout(&out).contains("link target `CFR:99-3.44` does not resolve"),
        "{}",
        stdout(&out)
    );
    assert!(!sect_index::index_dir(tmp.path())
        .join("manifest.json")
        .exists());
}

#[test]
fn queries_refresh_a_stale_index_unless_told_not_to() {
    let tmp = corpus_copy();
    assert!(sect(tmp.path(), &["index"]).status.success());
    let file = tmp.path().join("cfr-title-99/I/A/1/1.1/99-1.1.md");
    let mut text = fs::read_to_string(&file).unwrap();
    text.push_str("\n(e) An added paragraph for the freshness test.\n");
    fs::write(&file, text).unwrap();
    let stale = stdout(&sect(tmp.path(), &["status", "--no-refresh"]));
    assert!(
        stale.starts_with("freshness: possibly_stale (1 of 48 files changed"),
        "{stale}"
    );
    let refreshed = stdout(&sect(tmp.path(), &["status"]));
    assert!(
        refreshed.starts_with("freshness: fresh (rebuilt after 1 changed file(s)"),
        "{refreshed}"
    );
    let again = stdout(&sect(tmp.path(), &["status"]));
    assert!(
        again.starts_with("freshness: fresh (48 files indexed"),
        "{again}"
    );
    let read = stdout(&sect(tmp.path(), &["read", "CFR:99-1.1"]));
    assert!(read.contains("added paragraph for the freshness test"));
}
