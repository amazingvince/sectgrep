//! Spec B.3: the seven verbs over MCP stdio, the admin verbs only under --toolset full, HTTP on
//! loopback only, and `sect install` registering the server without touching anything else in
//! a client's config.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

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

struct Stdio_ {
    child: std::process::Child,
    reader: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl Stdio_ {
    fn start(corpus: &Path, extra: &[&str]) -> Stdio_ {
        let mut child = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(corpus).arg("serve").args(extra).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let reader = BufReader::new(child.stdout.take().unwrap());
        let mut s = Stdio_ { child, reader, next_id: 1 };
        let r = s.request("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}));
        assert_eq!(r["result"]["serverInfo"]["name"], "sect", "{r}");
        assert!(r["result"]["instructions"].as_str().unwrap().contains("freshness line"));
        s.notify("notifications/initialized");
        s
    }
    fn send(&mut self, v: &Value) {
        let stdin = self.child.stdin.as_mut().unwrap();
        writeln!(stdin, "{v}").unwrap();
        stdin.flush().unwrap();
    }
    fn notify(&mut self, method: &str) {
        self.send(&json!({"jsonrpc": "2.0", "method": method}));
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let mut line = String::new();
            let n = self.reader.read_line(&mut line).unwrap();
            assert!(n > 0, "server closed stdout while waiting for {method}");
            let v: Value = serde_json::from_str(line.trim()).unwrap_or_else(|_| panic!("not json-rpc: {line}"));
            if v["id"] == json!(id) {
                return v;
            }
        }
    }
    fn call(&mut self, tool: &str, args: Value) -> Value {
        let r = self.request("tools/call", json!({"name": tool, "arguments": args}));
        assert!(r.get("error").is_none(), "{r}");
        r["result"].clone()
    }
    fn text(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap_or("").to_string()
    }
}

impl Drop for Stdio_ {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

#[test]
fn seven_verbs_over_stdio_and_admin_only_with_full_toolset() {
    if std::env::var("SECT_TEST_NO_MODEL").is_ok() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fixture(), tmp.path());
    let mut s = Stdio_::start(tmp.path(), &[]);
    let tools = s.request("tools/list", json!({}));
    let mut names: Vec<String> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, ["sect_define", "sect_grep", "sect_map", "sect_read", "sect_refs", "sect_search", "sect_status"]);
    let search = tools["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "sect_search").unwrap();
    assert_eq!(search["inputSchema"]["required"], json!(["query"]));
    assert!(search["inputSchema"]["properties"]["as_of"]["description"].as_str().unwrap().contains("YYYY-MM-DD"));

    let r = s.call("sect_status", json!({}));
    let t = Stdio_::text(&r);
    assert!(t.starts_with("freshness: fresh"), "{t}");
    assert_eq!(r["structuredContent"]["freshness"]["state"], "fresh");
    let t = Stdio_::text(&s.call("sect_read", json!({"id": "CFR:99-2.7", "as_of": "2025-06-01"})));
    assert!(t.contains("§ 2.7") && t.contains("2024-01-01"), "{t}");
    let t = Stdio_::text(&s.call("sect_search", json!({"query": "99 CFR 2.8", "limit": 3})));
    assert!(t.contains("CFR:99-2.8"), "{t}");
    let t = Stdio_::text(&s.call("sect_grep", json!({"pattern": "cage", "ignore_case": true, "count_only": true})));
    assert!(t.starts_with("freshness:") && t.contains("count"), "{t}");
    let t = Stdio_::text(&s.call("sect_refs", json!({"id": "CFR:99-2.8", "direction": "in"})));
    assert!(t.contains("CFR:99-2.4"), "{t}");
    let t = Stdio_::text(&s.call("sect_define", json!({"term": "qualified person"})));
    assert!(t.contains("CFR:99-1.2"), "{t}");
    let t = Stdio_::text(&s.call("sect_map", json!({"scope": "CFR:99-2.13#c", "complete": true})));
    assert!(t.contains("c-1"), "{t}");
    // A verb error is a tool error, not a protocol error.
    let r = s.call("sect_read", json!({"id": "CFR:99-9.99"}));
    assert_eq!(r["isError"], true, "{r}");
    // Unknown fields are rejected by the shared definitions.
    let r = s.request("tools/call", json!({"name": "sect_search", "arguments": {"query": "x", "bogus": 1}}));
    assert!(r.get("error").is_some() || r["result"]["isError"] == true, "{r}");
    drop(s);

    let mut full = Stdio_::start(tmp.path(), &["--toolset", "full"]);
    let tools = full.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names.len(), 9);
    assert!(names.contains(&"sect_index") && names.contains(&"sect_rebuild"));
    let t = Stdio_::text(&full.call("sect_index", json!({})));
    assert!(t.starts_with("freshness: fresh (nothing changed"), "{t}");
}

#[test]
fn http_is_loopback_only() {
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(fixture()).args(["serve", "--http", "0.0.0.0:7999"]).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("loopback"));
}

#[test]
fn install_places_the_binary_and_merges_the_client_config() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    let cfg = tmp.path().join("claude_desktop_config.json");
    fs::write(&cfg, r#"{"mcpServers": {"other": {"command": "x"}}, "theme": "dark"}"#).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(fixture()).args(["install", "--to"]).arg(&bin).args(["--client", "claude-desktop", "--config"]).arg(&cfg).arg("--json").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let r: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(r["copied"], true);
    let exe = bin.join(if cfg!(windows) { "sect.exe" } else { "sect" });
    assert!(exe.is_file());
    let written: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(written["theme"], "dark", "other keys survive");
    assert_eq!(written["mcpServers"]["other"]["command"], "x", "other servers survive");
    assert_eq!(written["mcpServers"]["sect"]["command"].as_str().unwrap(), exe.to_string_lossy().as_ref());
    let args: Vec<String> = written["mcpServers"]["sect"]["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(args[0], "serve");
    assert!(args.contains(&"--corpus".to_string()));
    // The installed binary works and serves.
    let out = Command::new(&exe).arg("--corpus").arg(fixture()).args(["--version"]).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("sect "));
    // Dry run writes nothing and shows the plan.
    let cfg2 = tmp.path().join("cursor.json");
    let out = Command::new(env!("CARGO_BIN_EXE_sect")).arg("--corpus").arg(fixture()).args(["install", "--to"]).arg(&bin).args(["--client", "cursor", "--config"]).arg(&cfg2).args(["--dry-run", "--full"]).output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("--toolset") && text.contains("dry run"), "{text}");
    assert!(!cfg2.exists());
}
