//! `sect grep` must print what ripgrep prints (spec B.1: `path:line:text` compatible with ripgrep).
//! Every case in eval/golden/grep/cases.jsonl is compared with the golden output recorded from
//! ripgrep 14 (eval/golden/grep/<id>.txt) and, when an `rg` binary is on PATH, with ripgrep live.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn corpus() -> PathBuf {
    repo().join("fixtures/corpus")
}

/// Normalise the path prefix of an rg output line to forward slashes (Windows prints `\`).
fn normalize(line: &str) -> String {
    let cut = line.find(".md").or_else(|| line.find(".yaml")).unwrap_or(0);
    let (head, tail) = line.split_at(cut);
    format!("{}{}", head.replace('\\', "/"), tail)
}

fn sect_output(args: &[String]) -> Vec<String> {
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus()).arg("grep").args(args).output().unwrap();
    assert!(out.status.success(), "sect grep {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut lines = text.lines();
    assert!(lines.next().unwrap().starts_with("freshness: "), "{text}");
    assert!(lines.next().unwrap().starts_with("counts: "), "{text}");
    lines.filter(|l| !l.starts_with("note: ")).map(str::to_string).collect()
}

/// `RG=<path>` points at a ripgrep binary; otherwise `rg` on PATH; otherwise golden-only.
fn rg_bin() -> String {
    std::env::var("RG").unwrap_or_else(|_| "rg".to_string())
}

fn rg_available() -> bool {
    Command::new(rg_bin()).arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn rg_output(args: &[String]) -> Vec<String> {
    let out = Command::new(rg_bin()).current_dir(corpus()).args(["--sort", "path", "-n", "--color", "never"]).args(args).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().map(normalize).collect()
}

#[test]
fn grep_matches_ripgrep_on_every_case() {
    let cases: Vec<Value> = std::fs::read_to_string(repo().join("eval/golden/grep/cases.jsonl")).unwrap().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
    assert!(cases.len() >= 20, "need at least 20 parity cases, have {}", cases.len());
    let live = rg_available();
    let mut checked = 0;
    for c in &cases {
        let id = c["id"].as_str().unwrap();
        let args: Vec<String> = c["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
        let mut rg_args = args.clone();
        if let Some(extra) = c["rg_extra"].as_array() {
            rg_args.extend(extra.iter().map(|a| a.as_str().unwrap().to_string()));
        }
        let got = sect_output(&args);
        let golden_path = repo().join("eval/golden/grep").join(format!("{id}.txt"));
        let golden: Vec<String> = std::fs::read_to_string(&golden_path).unwrap_or_else(|_| panic!("missing golden {}; run `uv run --project proto python eval/eval_m3.py --update-golden`", golden_path.display())).lines().map(str::to_string).collect();
        assert_eq!(got, golden, "case {id} {args:?}: sect grep differs from the ripgrep golden");
        if live {
            let rg = rg_output(&rg_args);
            assert_eq!(got, rg, "case {id} {args:?}: sect grep differs from live ripgrep");
        }
        assert!(!got.is_empty() || id == "g99", "case {id} produced no lines; a parity case must exercise something");
        checked += 1;
    }
    eprintln!("grep parity: {checked} cases match the golden ripgrep output{}", if live { " and live ripgrep" } else { " (rg not on PATH, golden only)" });
}

#[test]
fn grep_specific_behaviours() {
    // --max-hits bounds the answer with per-file counts and a note.
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus()).args(["grep", "the", "--max-hits", "5"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.lines().nth(1).unwrap().contains("over-max-hits 1"), "{text}");
    assert!(text.lines().nth(2).unwrap().starts_with("note: "), "{text}");
    assert!(text.lines().skip(3).all(|l| l.rsplit_once(':').map(|(_, n)| n.parse::<usize>().is_ok()).unwrap_or(false)), "{text}");
    // --count-only
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus()).args(["grep", "--count-only", "toeboard"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.lines().skip(2).all(|l| l.contains(':')), "{text}");
    // --annotate names the section and paragraph.
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus()).args(["grep", "--annotate", "48 inches"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.contains("\t[CITY:AM-1#a AM-1 Guardrail systems"), "{text}");
    // --scope limits files; --json has the header first.
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus()).args(["grep", "-c", "employer", "--scope", "CFR:99-3", "--json"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.trim_start().starts_with("{\n  \"freshness\""), "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert!(v["result"]["per_file"].as_array().unwrap().iter().all(|f| f["path"].as_str().unwrap().contains("/3/")), "{text}");
    // -N drops line numbers.
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus()).args(["grep", "-N", "Special duty"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.lines().nth(2).unwrap().starts_with("cfr-title-99/I/A/2/2.6/99-2.6.md:| Special duty"), "{text}");
}
