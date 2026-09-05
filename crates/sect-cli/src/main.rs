//! `sect`: the CLI. The verbs live in `sect-verbs` (shared with the MCP server); this file adds
//! the global flags, `serve`, and `install`.

mod install;

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use sect_core::Result;
use sect_mcp::{SectServer, Toolset};
use sect_verbs::Verb;

#[derive(Parser)]
#[command(
    name = "sect",
    version,
    about = "Search and navigate a structured corpus of rules. Every answer starts with a freshness line and a counts line."
)]
struct Cli {
    /// Corpus root (the directory that holds the sources and .sect/).
    #[arg(long, global = true, env = "SECT_CORPUS", default_value = ".")]
    corpus: PathBuf,
    /// JSON output (freshness and counts first, then the result).
    #[arg(long, global = true)]
    json: bool,
    /// Answer from the index as it is, even if files changed (the answer says `possibly_stale`).
    #[arg(long, global = true)]
    no_refresh: bool,
    /// What a query does with a stale index: `auto` refreshes small change sets now and large
    /// ones in the background, `wait` always refreshes first, `no` answers as-is.
    #[arg(long, global = true, default_value = "auto", value_parser = ["auto", "wait", "no"])]
    freshness: String,
    /// Include superseded Expressions (default: current text only).
    #[arg(long, global = true)]
    include_superseded: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(flatten)]
    Verb(Verb),
    /// Serve the seven verbs as MCP tools: stdio by default, or streamable HTTP on a loopback address.
    Serve(ServeArgs),
    /// Place the binary on the PATH and register the MCP server with a client.
    Install(install::InstallArgs),
}

#[derive(Debug, Clone, Args)]
struct ServeArgs {
    /// Serve over HTTP at this loopback address instead of stdio, e.g. 127.0.0.1:7999.
    #[arg(long, value_name = "ADDR")]
    http: Option<String>,
    /// `seven` (the query verbs) or `full` (adds sect_index and sect_rebuild).
    #[arg(long, default_value = "seven", value_parser = ["seven", "full"])]
    toolset: String,
}

fn main() {
    let code = match run() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32> {
    let cli = Cli::parse();
    let policy = if cli.no_refresh {
        sect_core::Refresh::No
    } else {
        sect_core::Refresh::parse(&cli.freshness).unwrap_or(sect_core::Refresh::Auto)
    };
    match cli.cmd {
        Cmd::Verb(verb) => {
            let out = sect_verbs::run(&cli.corpus, policy, cli.include_superseded, &verb)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&out.json)?);
            } else {
                print!("{}", out.text);
            }
            Ok(out.exit)
        }
        Cmd::Serve(args) => {
            let toolset = Toolset::parse(&args.toolset).unwrap_or(Toolset::Seven);
            let server = SectServer::new(
                sect_index::absolutize(&cli.corpus),
                policy,
                cli.include_superseded,
                toolset,
            );
            let rt = tokio::runtime::Runtime::new()
                .map_err(|e| sect_core::SectError::Other(e.to_string()))?;
            rt.block_on(async move {
                match args.http {
                    Some(addr) => {
                        let addr: std::net::SocketAddr = addr.parse().map_err(|e| {
                            sect_core::SectError::Other(format!("--http {addr}: {e}"))
                        })?;
                        sect_mcp::serve_http(server, addr).await
                    }
                    None => sect_mcp::serve_stdio(server).await,
                }
            })?;
            Ok(0)
        }
        Cmd::Install(args) => {
            let r = install::install(&args, &cli.corpus)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({ "binary": r.binary, "copied": r.copied, "registrations": r.registrations, "notes": r.notes })
                );
            } else {
                print!("{}", install::report_text(&r, args.dry_run));
            }
            Ok(0)
        }
    }
}
