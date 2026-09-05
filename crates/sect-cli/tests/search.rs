//! `sect search` on the fixture: modes, filters, as-of snapping, collapse, bounds, and the header.
//! Needs the embedding model: fetched from the hub on first run into the Hugging Face cache
//! (`HF_HOME` honoured), then copied next to the index. Set `SECT_TEST_NO_MODEL=1` to skip.

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

fn ids(o: &Output) -> Vec<String> {
    let v: Value = serde_json::from_str(&stdout(o)).unwrap_or_else(|_| {
        panic!(
            "not json: {}{}",
            stdout(o),
            String::from_utf8_lossy(&o.stderr)
        )
    });
    v["result"]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn search_fuses_filters_and_collapses() {
    if std::env::var("SECT_TEST_NO_MODEL").is_ok() {
        eprintln!("skipped: SECT_TEST_NO_MODEL");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fixture(), tmp.path());
    let build = sect(tmp.path(), &["index"]);
    assert!(
        build.status.success(),
        "{}{}",
        stdout(&build),
        String::from_utf8_lossy(&build.stderr)
    );
    for f in [
        "chunks.jsonl",
        "vectors.bin",
        "tantivy/meta.json",
        "semantic/model/model.safetensors",
    ] {
        assert!(
            sect_index::index_dir(tmp.path()).join(f).exists(),
            "missing .sect/{f}"
        );
    }

    let out = sect(tmp.path(), &["search", "toeboard height at a guardrail"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = stdout(&out);
    assert!(text.starts_with("freshness: fresh"), "{text}");
    assert!(
        text.lines().nth(1).unwrap().starts_with("counts: "),
        "{text}"
    );
    assert!(text.contains("mode fuse"), "{text}");
    let top: Vec<String> = ids(&sect(
        tmp.path(),
        &["search", "toeboard height at a guardrail", "--json"],
    ));
    assert!(top[..3].contains(&"CFR:99-2.8".to_string()), "{top:?}");
    let mut dedup = top.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(dedup.len(), top.len(), "one hit per section: {top:?}");

    // Citation-shaped query lands through the citations field.
    let top = ids(&sect(
        tmp.path(),
        &["search", "99 CFR 2.8", "--fts", "--json"],
    ));
    assert_eq!(top[0], "CFR:99-2.8", "{top:?}");

    // Modes.
    for (flag, mode) in [
        ("--fts", "\"fts\""),
        ("--vector", "\"vector\""),
        ("--fuse", "\"fuse\""),
    ] {
        let out = sect(tmp.path(), &["search", "ladder", flag, "--json"]);
        assert!(
            out.status.success(),
            "{flag}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            stdout(&out).contains(&format!("\"mode\": {mode}")),
            "{flag}"
        );
    }

    // Filters: kind, source, scope, limit.
    let out = sect(
        tmp.path(),
        &["search", "guardrail", "--kind", "overlay", "--json"],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert!(
        v["result"]["hits"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["kind"] == "overlay"),
        "{}",
        stdout(&out)
    );
    let out = sect(
        tmp.path(),
        &["search", "records", "--scope", "CFR:99-3", "--json"],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert!(
        v["result"]["hits"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["id"].as_str().unwrap().starts_with("CFR:99-3")),
        "{}",
        stdout(&out)
    );
    let out = sect(
        tmp.path(),
        &["search", "employer", "--limit", "3", "--json"],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(v["result"]["hits"].as_array().unwrap().len(), 3);
    let out = sect(
        tmp.path(),
        &["search", "employer", "--limit", "500", "--json"],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(v["result"]["limit"], 50);

    // As-of snapping: the 2024 Expression of § 2.7 answers in mid-2025, the 2026 one afterwards.
    let out = sect(
        tmp.path(),
        &[
            "search",
            "fixed ladder cage requirement",
            "--as-of",
            "2025-06-01",
            "--json",
        ],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    let exprs: Vec<&str> = v["result"]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["expr"].as_str().unwrap())
        .collect();
    assert!(exprs.contains(&"CFR:99-2.7@2024-01-01"), "{exprs:?}");
    assert!(!exprs.contains(&"CFR:99-2.7@2026-01-01"), "{exprs:?}");
    let out = sect(
        tmp.path(),
        &["search", "fixed ladder cage requirement", "--json"],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    let exprs: Vec<&str> = v["result"]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["expr"].as_str().unwrap())
        .collect();
    assert!(
        exprs.contains(&"CFR:99-2.7@2026-01-01") && !exprs.contains(&"CFR:99-2.7@2024-01-01"),
        "current-only by default: {exprs:?}"
    );
    // With --include-superseded the 2024 text is a candidate again, carrying the -0.5 penalty,
    // so it ranks below the current text and its neighbours but is present in the full list.
    let out = sect(
        tmp.path(),
        &[
            "search",
            "fixed ladder cage requirement",
            "--include-superseded",
            "--limit",
            "50",
            "--json",
        ],
    );
    let v: Value = serde_json::from_str(&stdout(&out)).unwrap();
    let exprs: Vec<&str> = v["result"]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["expr"].as_str().unwrap())
        .collect();
    assert!(exprs.contains(&"CFR:99-2.7@2024-01-01"), "{exprs:?}");
    let old_pos = exprs
        .iter()
        .position(|e| *e == "CFR:99-2.7@2024-01-01")
        .unwrap();
    let new_pos = exprs
        .iter()
        .position(|e| *e == "CFR:99-2.7@2026-01-01")
        .unwrap();
    assert!(
        new_pos < old_pos,
        "the superseded text ranks below the current one: {exprs:?}"
    );

    // JSON header order and the remote-provider refusal.
    let text = stdout(&sect(tmp.path(), &["search", "exit", "--json"]));
    assert!(
        text.trim_start().starts_with("{\n  \"freshness\""),
        "{text}"
    );
    let out = sect(
        tmp.path(),
        &[
            "index",
            "--embedding",
            "remote:https://example.invalid/embed",
        ],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("opt-in"));
}

#[test]
fn search_signals_pins_expansion_seed_and_abstention() {
    if std::env::var("SECT_TEST_NO_MODEL").is_ok() {
        return;
    }
    let tmp = corpus_copy_indexed();
    let hit = |args: &[&str]| -> Value {
        serde_json::from_str(&stdout(&sect(
            tmp.path(),
            &[&["search"], args, &["--json"]].concat(),
        )))
        .unwrap()
    };

    // Citation short-circuit: rank 1 with the anchor, even when the vector leg disagrees.
    let v = hit(&["What does 99 CFR 1.10 say?"]);
    assert_eq!(v["result"]["hits"][0]["id"], "CFR:99-1.10", "{v}");
    assert_eq!(v["result"]["hits"][0]["pinned"], "citation short-circuit");
    let v = hit(&["§ 1.5(a)(2)"]);
    assert_eq!(v["result"]["hits"][0]["anchor"], "a-2");
    assert_eq!(v["result"]["id_or_term_like"], true);
    assert_eq!(v["result"]["weights"][0], 2.0);

    // Definition resolution: the defining section first, with the term anchor.
    let v = hit(&["what is a hole"]);
    assert_eq!(v["result"]["hits"][0]["id"], "CFR:99-2.2", "{v}");
    assert_eq!(v["result"]["hits"][0]["anchor"], "hole");
    assert!(v["result"]["hits"][0]["pinned"]
        .as_str()
        .unwrap()
        .starts_with("definition resolution"));
    // A long question that merely mentions a defined word is not define-shaped or term-like.
    let v = hit(&["what is the maximum penalty when an employer should have known about a hazard"]);
    assert!(v["result"]["hits"][0]["pinned"].is_null(), "{v}");
    assert_eq!(v["result"]["id_or_term_like"], false);

    // Notes never outrank rule text; superseded text is excluded by default.
    let v = hit(&["exit access width 28 inches versus 36 inches"]);
    assert_ne!(
        v["result"]["hits"][0]["id"], "NOTE:egress-width-across-jurisdictions",
        "{v}"
    );

    // --expand refs and --expand ancestors.
    let v = hit(&[
        "duty to have fall protection at unprotected edges",
        "--expand",
        "refs",
    ]);
    let top = &v["result"]["hits"][0];
    assert_eq!(top["id"], "CFR:99-2.4", "{v}");
    assert!(
        top["expanded"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "CFR:99-2.8"),
        "{top}"
    );
    let v = hit(&["guardrail systems", "--expand", "ancestors"]);
    assert!(
        v["result"]["hits"][0]["expanded"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "CFR:99-2"),
        "{v}"
    );

    // --seed --budget: lexical-heavy, bounded.
    let v = hit(&["ladders and fall protection", "--seed", "--budget", "120"]);
    assert_eq!(v["result"]["weights"][0], 3.0);
    let seed = &v["result"]["seed"];
    assert!(seed["tokens"].as_u64().unwrap() <= 120, "{seed}");
    assert!(seed["entries"].as_u64().unwrap() >= 1);
    let text = stdout(&sect(
        tmp.path(),
        &[
            "search",
            "ladders and fall protection",
            "--seed",
            "--budget",
            "120",
        ],
    ));
    assert!(text.contains("seed: "), "{text}");
    assert!(text.contains("- CFR:99-"), "{text}");

    // Abstention with nearest scope.
    let v = hit(&["zxqv plorb wibble frobnicate"]);
    assert_eq!(v["result"]["abstained"], true, "{v}");
    assert!(v["result"]["nearest"].is_string());
    let text = stdout(&sect(
        tmp.path(),
        &["search", "zxqv plorb wibble frobnicate"],
    ));
    assert!(
        text.lines().nth(1).unwrap().contains("abstained 1"),
        "{text}"
    );
    assert!(
        text.contains("not found: nothing above the confidence floor"),
        "{text}"
    );
    let v = hit(&["toeboard height at a guardrail"]);
    assert_eq!(v["result"]["abstained"], false);
}

fn corpus_copy_indexed() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fixture(), tmp.path());
    let build = sect(tmp.path(), &["index"]);
    assert!(
        build.status.success(),
        "{}{}",
        stdout(&build),
        String::from_utf8_lossy(&build.stderr)
    );
    tmp
}
