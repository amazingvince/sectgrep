//! `sect`: single binary, no daemon, no network at query time (spec B.1).

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use sect_core::Result;
use sect_index::BuildOptions;
use sect_query::ReadOptions;

#[derive(Parser)]
#[command(name = "sect", version, about = "Search and navigate a structured corpus of rules. Every answer starts with a freshness line and a counts line.")]
struct Cli {
    /// Corpus root: the directory whose subdirectories carry `_source.yaml`.
    #[arg(long, global = true, env = "SECT_CORPUS", default_value = ".")]
    corpus: PathBuf,
    /// JSON output (`freshness` and `counts` first, then `result`).
    #[arg(long, global = true)]
    json: bool,
    /// Answer from the index as it is, even if files changed (the answer says `possibly_stale`).
    #[arg(long, global = true)]
    no_refresh: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Build or refresh the index under <corpus>/.sect (walk, fingerprint, validate, structural files).
    Index {
        /// Corpus root (overrides --corpus).
        path: Option<PathBuf>,
        /// Re-hash every file instead of trusting stored fingerprints.
        #[arg(long)]
        full: bool,
        /// Check the B.2 contract only; write nothing. Exit 1 on errors.
        #[arg(long)]
        validate_only: bool,
    },
    /// Show a section (Work id or Expression id) with its structural context.
    Read {
        id: String,
        #[arg(long)]
        ancestors: bool,
        #[arg(long)]
        children: bool,
    },
    /// Table of contents under a scope, bounded by a token budget.
    Map {
        #[arg(long)]
        scope: Option<String>,
        #[arg(long, default_value_t = 3)]
        depth: usize,
        #[arg(long, default_value_t = 1500)]
        budget: usize,
    },
    /// Freshness, counts, warnings, and the legal-status summary of the corpus.
    Status,
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
    match cli.cmd {
        Cmd::Index { path, full, validate_only } => {
            let root = path.unwrap_or(cli.corpus);
            let rep = sect_index::build(&root, &BuildOptions { full, validate_only })?;
            if cli.json {
                println!("{}", serde_json_string(&rep));
            } else {
                print!("{}", sect_format::build_text(&rep));
            }
            Ok(if rep.errors() > 0 { 1 } else { 0 })
        }
        Cmd::Read { id, ancestors, children } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let r = sect_query::read(&index, &id, &ReadOptions { ancestors, children })?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::read_text(&r) });
            Ok(0)
        }
        Cmd::Map { scope, depth, budget } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let r = sect_query::map(&index, scope.as_deref(), depth, budget)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::map_text(&r) });
            Ok(0)
        }
        Cmd::Status => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let r = sect_query::status(&index)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::status_text(&r) });
            Ok(0)
        }
    }
}

fn serde_json_string(rep: &sect_index::BuildReport) -> String {
    sect_format::json_value(rep)
}
