//! `sect install`: place the binary on the PATH and register the MCP server with a client
//! (spec B.3, milestone 7). Registration is a JSON merge into the client's config file, or the
//! `claude mcp add` command for Claude Code, never a registry publish.

use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Args;
use sect_core::{Result, SectError};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Args)]
pub struct InstallArgs {
    /// Directory to place the binary in (default: ~/.cargo/bin if it exists, else ~/.local/bin;
    /// on Windows %LOCALAPPDATA%\sect\bin).
    #[arg(long, value_name = "DIR")]
    pub to: Option<PathBuf>,
    /// Register the MCP server with this client: claude-code, claude-desktop, cursor, or none.
    /// May be repeated.
    #[arg(long, value_name = "CLIENT", default_value = "claude-code", value_parser = ["claude-code", "claude-desktop", "cursor", "none"])]
    pub client: Vec<String>,
    /// Client config file to write (overrides the client's default location; one client only).
    #[arg(long, value_name = "PATH")]
    pub config: Option<PathBuf>,
    /// For claude-code: write a project-scoped `.mcp.json` in the current directory instead of
    /// running `claude mcp add`.
    #[arg(long)]
    pub project: bool,
    /// Expose the admin verbs too (`serve --toolset full`).
    #[arg(long)]
    pub full: bool,
    /// Show what would be done; write nothing.
    #[arg(long)]
    pub dry_run: bool,
}

pub struct InstallReport {
    pub binary: PathBuf,
    pub copied: bool,
    pub registrations: Vec<String>,
    pub notes: Vec<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn default_bin_dir() -> Result<PathBuf> {
    let home = home().ok_or_else(|| {
        SectError::Other("cannot find the home directory (HOME or USERPROFILE)".into())
    })?;
    let cargo = home.join(".cargo").join("bin");
    if cargo.is_dir() {
        return Ok(cargo);
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(local).join("sect").join("bin"));
        }
    }
    Ok(home.join(".local").join("bin"))
}

fn client_config_path(client: &str) -> Option<PathBuf> {
    let home = home()?;
    match client {
        "claude-desktop" => {
            if cfg!(target_os = "macos") {
                Some(home.join("Library/Application Support/Claude/claude_desktop_config.json"))
            } else if cfg!(windows) {
                std::env::var_os("APPDATA").map(|a| {
                    PathBuf::from(a)
                        .join("Claude")
                        .join("claude_desktop_config.json")
                })
            } else {
                Some(home.join(".config/Claude/claude_desktop_config.json"))
            }
        }
        "cursor" => Some(home.join(".cursor").join("mcp.json")),
        _ => None,
    }
}

/// The server entry every client understands: the installed binary, `serve`, the corpus.
pub fn server_entry(binary: &Path, corpus: &Path, full: bool) -> Value {
    let mut args = vec![
        "serve".to_string(),
        "--corpus".to_string(),
        corpus.to_string_lossy().to_string(),
    ];
    if full {
        args.push("--toolset".into());
        args.push("full".into());
    }
    json!({ "command": binary.to_string_lossy(), "args": args })
}

/// Merge `mcpServers.sect` into a JSON config file, keeping everything else in it.
pub fn merge_into(path: &Path, entry: &Value, dry_run: bool) -> Result<String> {
    let mut root: Value = match std::fs::read_to_string(path) {
        Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).map_err(|e| {
            SectError::Other(format!(
                "{}: not JSON ({e}); fix it or pass --config",
                path.display()
            ))
        })?,
        _ => Value::Object(Map::new()),
    };
    if !root.is_object() {
        return Err(SectError::Other(format!(
            "{}: top level is not an object",
            path.display()
        )));
    }
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    if !servers.is_object() {
        return Err(SectError::Other(format!(
            "{}: mcpServers is not an object",
            path.display()
        )));
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert("sect".into(), entry.clone());
    let text = serde_json::to_string_pretty(&root)? + "\n";
    if !dry_run {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| SectError::io(parent, e))?;
        }
        std::fs::write(path, &text).map_err(|e| SectError::io(path, e))?;
    }
    Ok(text)
}

pub fn install(args: &InstallArgs, corpus: &Path) -> Result<InstallReport> {
    let corpus = sect_index::absolutize(corpus);
    let dir = match &args.to {
        Some(d) => d.clone(),
        None => default_bin_dir()?,
    };
    let exe = std::env::current_exe().map_err(|e| SectError::Other(format!("current_exe: {e}")))?;
    let name = if cfg!(windows) { "sect.exe" } else { "sect" };
    let binary = dir.join(name);
    let same =
        std::fs::canonicalize(&exe).ok() == std::fs::canonicalize(&binary).ok() && binary.exists();
    let mut notes = Vec::new();
    let mut copied = false;
    if same {
        notes.push(format!("binary already at {}", binary.display()));
    } else if args.dry_run {
        notes.push(format!(
            "would copy {} to {}",
            exe.display(),
            binary.display()
        ));
    } else {
        std::fs::create_dir_all(&dir).map_err(|e| SectError::io(&dir, e))?;
        std::fs::copy(&exe, &binary).map_err(|e| SectError::io(&binary, e))?;
        copied = true;
    }
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d == dir))
        .unwrap_or(false);
    if !on_path {
        notes.push(format!(
            "{} is not on PATH; add it or call the binary by its full path",
            dir.display()
        ));
    }
    let entry = server_entry(&binary, &corpus, args.full);
    let mut registrations = Vec::new();
    let clients: Vec<&str> = args
        .client
        .iter()
        .map(|s| s.as_str())
        .filter(|c| *c != "none")
        .collect();
    if args.config.is_some() && clients.len() > 1 {
        return Err(SectError::Other(
            "--config applies to one client; pass one --client".into(),
        ));
    }
    for client in clients {
        match client {
            "claude-code" if args.project || args.config.is_some() => {
                let path = args
                    .config
                    .clone()
                    .unwrap_or_else(|| PathBuf::from(".mcp.json"));
                let text = merge_into(&path, &entry, args.dry_run)?;
                registrations.push(format!(
                    "claude-code (project): {}{}",
                    path.display(),
                    if args.dry_run {
                        format!("\n{text}")
                    } else {
                        String::new()
                    }
                ));
            }
            "claude-code" => {
                let mut cmd = vec![
                    "claude".to_string(),
                    "mcp".into(),
                    "add".into(),
                    "--scope".into(),
                    "user".into(),
                    "sect".into(),
                    "--".into(),
                    binary.to_string_lossy().to_string(),
                    "serve".into(),
                    "--corpus".into(),
                    corpus.to_string_lossy().to_string(),
                ];
                if args.full {
                    cmd.push("--toolset".into());
                    cmd.push("full".into());
                }
                let shown = cmd.join(" ");
                if args.dry_run {
                    registrations.push(format!("claude-code (user scope): would run `{shown}`"));
                } else {
                    let claude = if cfg!(windows) {
                        "claude.cmd"
                    } else {
                        "claude"
                    };
                    let status = Command::new(claude)
                        .args(&cmd[1..])
                        .status()
                        .or_else(|_| Command::new("claude").args(&cmd[1..]).status());
                    match status {
                        Ok(s) if s.success() => registrations.push(format!("claude-code (user scope): ran `{shown}`")),
                        Ok(s) => notes.push(format!("`{shown}` exited with {s}; run it by hand or use --project")),
                        Err(_) => notes.push(format!("claude is not on PATH; run `{shown}` where it is, or use --project to write .mcp.json")),
                    }
                }
            }
            other => {
                let path = match &args.config {
                    Some(p) => p.clone(),
                    None => client_config_path(other).ok_or_else(|| {
                        SectError::Other(format!(
                            "no default config location for {other}; pass --config"
                        ))
                    })?,
                };
                let text = merge_into(&path, &entry, args.dry_run)?;
                registrations.push(format!(
                    "{other}: {}{}",
                    path.display(),
                    if args.dry_run {
                        format!("\n{text}")
                    } else {
                        String::new()
                    }
                ));
            }
        }
    }
    Ok(InstallReport {
        binary,
        copied,
        registrations,
        notes,
    })
}

pub fn report_text(r: &InstallReport, dry_run: bool) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "binary: {}{}\n",
        r.binary.display(),
        if r.copied {
            " (copied)"
        } else if dry_run {
            " (dry run)"
        } else {
            ""
        }
    ));
    for reg in &r.registrations {
        s.push_str(&format!("registered: {reg}\n"));
    }
    for n in &r.notes {
        s.push_str(&format!("note: {n}\n"));
    }
    s.push_str("verify: sect serve --corpus <corpus> then list tools from your client; the seven verbs are sect_search, sect_grep, sect_read, sect_refs, sect_define, sect_map, sect_status\n");
    s
}
