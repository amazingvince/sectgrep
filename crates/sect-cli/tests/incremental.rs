//! Spec B.6: incremental rebuilds, no work on unchanged input, freshness policies.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/corpus")
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

fn json(o: &Output) -> Value {
    serde_json::from_str(&stdout(o)).unwrap_or_else(|_| {
        panic!(
            "not json: {}{}",
            stdout(o),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

fn index_json(corpus: &Path, extra: &[&str]) -> Value {
    let out = sect(corpus, &[&["index"], extra, &["--json"]].concat());
    assert!(
        out.status.success(),
        "{}{}",
        stdout(&out),
        String::from_utf8_lossy(&out.stderr)
    );
    json(&out)
}

#[test]
fn incremental_rebuilds_touch_only_what_changed_and_noop_otherwise() {
    if std::env::var("SECT_TEST_NO_MODEL").is_ok() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fixture(), tmp.path());
    let first = index_json(tmp.path(), &[]);
    assert_eq!(first["mode"], "full");
    assert_eq!(first["added"], 48);
    assert!(sect_index::index_dir(tmp.path())
        .join("docs.jsonl")
        .is_file());

    // Unchanged input: no work.
    let again = index_json(tmp.path(), &[]);
    assert_eq!(again["mode"], "noop", "{again}");
    assert_eq!(again["written"], false);
    assert_eq!(again["changed"], 0);
    let text = stdout(&sect(tmp.path(), &["index"]));
    assert!(
        text.starts_with("freshness: fresh (nothing changed"),
        "{text}"
    );

    // One file edited: one parse, one Expression replaced in tantivy and vectors.bin.
    let file = tmp.path().join("cfr-title-99/I/A/1/1.1/99-1.1.md");
    let mut body = fs::read_to_string(&file).unwrap();
    body.push_str("\n(e) The zebrafish paragraph added for the incremental test.\n");
    fs::write(&file, body).unwrap();
    let inc = index_json(tmp.path(), &[]);
    assert_eq!(inc["mode"], "incremental", "{inc}");
    assert_eq!(inc["changed"], 1);
    assert_eq!(inc["added"], 0);
    assert_eq!(inc["written"], true);
    let v = json(&sect(
        tmp.path(),
        &["search", "zebrafish", "--fts", "--json"],
    ));
    assert_eq!(v["result"]["hits"][0]["id"], "CFR:99-1.1", "{v}");
    let v = json(&sect(
        tmp.path(),
        &[
            "search",
            "the zebrafish paragraph added for the incremental test",
            "--vector",
            "--limit",
            "5",
            "--json",
        ],
    ));
    assert!(
        v["result"]["hits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["id"] == "CFR:99-1.1"),
        "vector row replaced: {v}"
    );
    assert!(
        fs::read_to_string(sect_index::index_dir(tmp.path()).join("log.jsonl"))
            .unwrap()
            .contains("\"action\":\"incremental\"")
    );

    // A new file: added, then found; removed: gone.
    let new_file = tmp.path().join("cfr-title-99/I/A/1/1.11/99-1.11.md");
    fs::create_dir_all(new_file.parent().unwrap()).unwrap();
    let template =
        fs::read_to_string(tmp.path().join("cfr-title-99/I/A/1/1.10/99-1.10.md")).unwrap();
    let new_text = template
        .replace("CFR:99-1.10", "CFR:99-1.11")
        .replace("title: Civil penalties", "title: Quokka provisions")
        .replace("order: 10", "order: 11")
        .replace("99:1.1.1.1.10", "99:1.1.1.1.11")
        .replace("# § 1.10 Civil penalties", "# § 1.11 Quokka provisions");
    fs::write(&new_file, new_text).unwrap();
    let inc = index_json(tmp.path(), &[]);
    assert_eq!(inc["mode"], "incremental", "{inc}");
    assert_eq!(inc["added"], 1, "{inc}");
    assert_eq!(inc["files"], 45);
    let out = sect(tmp.path(), &["read", "CFR:99-1.11"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(stdout(&out).contains("Quokka provisions"));
    fs::remove_file(&new_file).unwrap();
    fs::remove_dir(new_file.parent().unwrap()).unwrap();
    let inc = index_json(tmp.path(), &[]);
    assert_eq!(inc["removed"], 1, "{inc}");
    assert_eq!(inc["files"], 44);
    assert!(!sect(tmp.path(), &["read", "CFR:99-1.11"]).status.success());
    let v = json(&sect(tmp.path(), &["search", "quokka", "--fts", "--json"]));
    assert!(
        v["result"]["hits"].as_array().unwrap().is_empty(),
        "removed Expression left the lexical layer: {v}"
    );
}

#[test]
fn freshness_policies_small_sync_large_background_wait_and_no() {
    if std::env::var("SECT_TEST_NO_MODEL").is_ok() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fixture(), tmp.path());
    assert!(sect(tmp.path(), &["index"]).status.success());
    let touch = |n: usize| {
        let mut count = 0;
        for entry in walkdir(tmp.path()) {
            if count == n {
                break;
            }
            let mut t = fs::read_to_string(&entry).unwrap();
            t.push_str("\n<!-- touched -->\n");
            fs::write(&entry, t).unwrap();
            count += 1;
        }
        count
    };

    // Small change set: a query refreshes synchronously.
    assert_eq!(touch(2), 2);
    let text = stdout(&sect(tmp.path(), &["status"]));
    assert!(
        text.starts_with("freshness: fresh (rebuilt after 2 changed file(s)"),
        "{text}"
    );
    let text = stdout(&sect(tmp.path(), &["status"]));
    assert!(
        text.starts_with("freshness: fresh (48 files indexed; stat"),
        "{text}"
    );

    // --freshness no answers as-is.
    assert_eq!(touch(3), 3);
    let text = stdout(&sect(tmp.path(), &["status", "--freshness", "no"]));
    assert!(
        text.starts_with("freshness: possibly_stale (3 of 48 files changed"),
        "{text}"
    );
    let text = stdout(&sect(tmp.path(), &["status", "--no-refresh"]));
    assert!(text.starts_with("freshness: possibly_stale"), "{text}");

    // --freshness wait rebuilds first, whatever the size.
    let text = stdout(&sect(tmp.path(), &["status", "--freshness", "wait"]));
    assert!(
        text.starts_with("freshness: fresh (rebuilt after 3 changed file(s)"),
        "{text}"
    );

    // Large change set: possibly_stale now, rebuilt in the background, fresh soon after.
    assert_eq!(touch(30), 30);
    let text = stdout(&sect(tmp.path(), &["status"]));
    assert!(
        text.starts_with("freshness: possibly_stale (30 of 48 files changed"),
        "{text}"
    );
    assert!(text.contains("rebuilding in background"), "{text}");
    let mut fresh = false;
    for _ in 0..120 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let text = stdout(&sect(tmp.path(), &["status", "--freshness", "no"]));
        if text.starts_with("freshness: fresh") {
            fresh = true;
            break;
        }
    }
    assert!(fresh, "background rebuild did not finish");
    let log = fs::read_to_string(sect_index::index_dir(tmp.path()).join("log.jsonl")).unwrap();
    assert!(
        log.matches("\"action\":\"incremental\"").count() >= 3,
        "{log}"
    );
}

fn walkdir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(p: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(p).unwrap().flatten() {
            let path = e.path();
            if path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(false)
            {
                continue;
            }
            if path.is_dir() {
                rec(&path, out);
            } else if path.extension().map(|x| x == "md").unwrap_or(false) {
                out.push(path);
            }
        }
    }
    rec(root, &mut out);
    out.sort();
    out
}
