//! Spec B.4: the n-gram prefilter never excludes a true match. Property test against brute
//! force: literals sampled from the files themselves (so true matches exist), turned into the
//! regex shapes agents use, run with and without `--no-index`; the outputs must be identical.
//! Runs on the fixture always and on corpora/ecfr (three converted titles) when present.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn md_files(root: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(root).unwrap().flatten() {
        let p = e.path();
        if p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false) {
            continue;
        }
        if p.is_dir() {
            md_files(&p, out);
        } else if p.extension().map(|x| x == "md").unwrap_or(false) {
            out.push(p);
        }
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn grep_json(corpus: &Path, args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus).args(["grep", "--json", "--max-hits", "5000"]).args(args).output().unwrap();
    assert!(out.status.success(), "{:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

fn comparable(v: &Value) -> Value {
    let r = &v["result"];
    serde_json::json!({
        "lines": r["lines"].as_array().unwrap().iter().map(|l| serde_json::json!([l["path"], l["line"], l["kind"], l["text"]])).collect::<Vec<_>>(),
        "per_file": r["per_file"],
        "total": r["total_matches"],
        "files_matched": r["files_matched"],
        "truncated": r["truncated"],
    })
}

/// Sample literals from lines, shape them the way agents write patterns, and compare.
fn property(corpus: &Path, samples: usize, seed: u64) -> (usize, usize) {
    let mut files = Vec::new();
    md_files(corpus, &mut files);
    files.sort();
    let mut rng = Rng(seed);
    let mut narrowed = 0usize;
    let mut checked = 0usize;
    let fixed: Vec<Vec<&str>> = vec![
        vec!["§ 1926"], vec!["1926\\.501"], vec!["\\bcage\\b"], vec!["(?i)GUARDRAIL"], vec!["toe ?board"], vec!["employ(er|ee)s?"], vec!["\\d+ inches"], vec!["^\\(a\\)"],
        vec!["[A-Z]{3}:"], vec!["respirator|ladder|scaffold"], vec!["-i", "federal register"], vec!["-w", "rail"], vec!["-F", "1.5(a)(2)"], vec!["shall\\s+not"], vec!["-e", "cage", "-e", "toeboard"],
        vec!["-i", "Élan"], vec!["a.b"], vec!["\\w+ing\\b"], vec!["-g", "*1.*", "the"], vec!["(guard|hand)rail"], vec!["[0-9]{4}\\.[0-9]+\\([a-z]\\)"],
    ];
    let mut cases: Vec<Vec<String>> = fixed.into_iter().map(|c| c.into_iter().map(String::from).collect()).collect();
    for i in 0..samples {
        let text = fs::read_to_string(&files[rng.below(files.len())]).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| l.len() >= 8 && !l.starts_with("---")).collect();
        if lines.is_empty() {
            continue;
        }
        let line = lines[rng.below(lines.len())];
        let chars: Vec<char> = line.chars().collect();
        let len = 3 + rng.below(22.min(chars.len() - 2));
        let start = rng.below(chars.len() - len + 1);
        let lit: String = chars[start..start + len].iter().collect();
        let lit = lit.trim().to_string();
        if lit.is_empty() {
            continue;
        }
        let esc = regex_escape(&lit);
        let case = match i % 8 {
            0 => vec!["-F".to_string(), lit.clone()],
            1 => vec!["-i".to_string(), "-F".to_string(), flip_case(&lit)],
            2 => vec!["-w".to_string(), esc.clone()],
            3 => {
                let other = chars[rng.below(chars.len().saturating_sub(4).max(1))..].iter().take(5).collect::<String>();
                vec![format!("{esc}|{}", regex_escape(other.trim()))]
            }
            4 => vec![esc.replace("\\ ", "\\s+").replace(' ', "\\s+")],
            5 => {
                let mid = lit.chars().count() / 2;
                let a: String = lit.chars().take(mid).collect();
                let b: String = lit.chars().skip(mid).collect();
                vec![format!("{}.*{}", regex_escape(&a), regex_escape(&b))]
            }
            6 => vec![esc.chars().map(|c| if c.is_ascii_digit() { "[0-9]".to_string() } else { c.to_string() }).collect::<String>()],
            _ => {
                let mut cs: Vec<char> = lit.chars().collect();
                let last = cs.pop().unwrap();
                vec![format!("{}{}?", regex_escape(&cs.iter().collect::<String>()), regex_escape(&last.to_string()))]
            }
        };
        cases.push(case);
    }
    for case in &cases {
        let args: Vec<&str> = case.iter().map(|s| s.as_str()).collect();
        let with = grep_json(corpus, &args);
        let mut noindex = args.clone();
        noindex.push("--no-index");
        let without = grep_json(corpus, &noindex);
        assert_eq!(comparable(&with), comparable(&without), "prefiltered grep differs from brute force for {case:?}\nwith: {}\nwithout: {}", with["result"]["prefilter"], without["counts"]);
        assert!(without["result"]["prefilter"].is_null(), "--no-index must skip the prefilter");
        checked += 1;
        if let Some(n) = with["result"]["prefilter"]["candidate_count"].as_u64() {
            if (n as usize) < with["result"]["prefilter"]["files_total"].as_u64().unwrap() as usize {
                narrowed += 1;
            }
        }
    }
    (checked, narrowed)
}

fn regex_escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn flip_case(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_lowercase() { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() }).collect()
}

fn indexed_copy(src: &Path) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(src, tmp.path());
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(tmp.path()).args(["index", "--ngram", "on", "--embedding", "none"]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(tmp.path().join(".sect/ngram/table.bin").is_file());
    tmp
}

#[test]
fn prefilter_never_excludes_a_true_match_on_the_fixture() {
    let tmp = indexed_copy(&repo().join("fixtures/corpus"));
    let (checked, narrowed) = property(tmp.path(), 120, 0x9e3779b97f4a7c15);
    eprintln!("fixture: {checked} cases, {narrowed} narrowed by the prefilter");
    assert!(checked >= 120);
    assert!(narrowed > checked / 3, "the prefilter narrowed only {narrowed} of {checked} cases");
    // --ngram off removes the layer and grep runs without it.
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(tmp.path()).args(["index", "--ngram", "off"]).output().unwrap();
    assert!(out.status.success());
    assert!(!tmp.path().join(".sect/ngram").exists());
    let v = grep_json(tmp.path(), &["cage"]);
    assert!(v["result"]["prefilter"].is_null());
}

#[test]
fn prefilter_never_excludes_a_true_match_on_the_real_corpus() {
    let src = repo().join("corpora/ecfr");
    if !src.join("cfr-title-1").is_dir() {
        eprintln!("corpora/ecfr not present; skipping the real-corpus property test");
        return;
    }
    let tmp = indexed_copy(&src);
    let (checked, narrowed) = property(tmp.path(), 120, 0x2545f4914f6cdd1d);
    eprintln!("ecfr: {checked} cases, {narrowed} narrowed by the prefilter");
    assert!(narrowed > checked / 3, "the prefilter narrowed only {narrowed} of {checked} cases");
}
