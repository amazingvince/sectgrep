//! `sect`: single binary, no daemon, no network at query time (spec B.1).

use std::path::PathBuf;

use chrono::NaiveDate;
use clap::{Parser, Subcommand};
use sect_core::{Result, SectError};
use sect_index::BuildOptions;
use sect_query::ReadOptions;
use sect_struct::Direction;

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
    /// With --as-of: treat every Expression published by the date as active, not just the snapped one.
    #[arg(long, global = true)]
    include_superseded: bool,
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
    /// Show a section (Work id, Expression id, or id#anchor) with its structural context.
    Read {
        id: String,
        #[arg(long)]
        ancestors: bool,
        #[arg(long)]
        children: bool,
        /// Include the section's tables as structured rows.
        #[arg(long)]
        tables: bool,
        /// List every Expression of the Work and the Actions between them.
        #[arg(long)]
        history: bool,
        /// Snap to the Expression in force on this date (YYYY-MM-DD).
        #[arg(long, value_name = "DATE")]
        as_of: Option<String>,
        /// Read a specific Expression id.
        #[arg(long, value_name = "EXPR")]
        version: Option<String>,
    },
    /// Table of contents under a scope, bounded by a token budget; --complete returns the whole subtree.
    Map {
        #[arg(long, value_name = "ID[#anchor]")]
        scope: Option<String>,
        #[arg(long, default_value_t = 3)]
        depth: usize,
        #[arg(long, default_value_t = 1500)]
        budget: usize,
        /// Full subtree by traversal (sections under a container, paragraphs under a section).
        #[arg(long)]
        complete: bool,
    },
    /// Cross-reference and amendment traversal: what points at this, what it points to.
    Refs {
        id: String,
        #[arg(long, default_value = "out", value_parser = ["in", "out", "both"])]
        direction: String,
        /// references | overrides | narrows | supersedes | amends | defines
        #[arg(long = "type", value_name = "TYPE")]
        kind: Option<String>,
        #[arg(long, default_value_t = 1)]
        depth: usize,
        #[arg(long, value_name = "DATE")]
        as_of: Option<String>,
    },
    /// Defined-term lookup by structural resolution.
    Define {
        term: String,
        /// List the sections that use the term.
        #[arg(long)]
        usages: bool,
        /// Limit usages to a subtree.
        #[arg(long, value_name = "ID")]
        scope: Option<String>,
        #[arg(long, value_name = "DATE")]
        as_of: Option<String>,
    },
    /// Freshness, counts, warnings, unresolved refs, and the legal-status summary of the corpus.
    Status,
}

fn parse_date(s: &Option<String>) -> Result<Option<NaiveDate>> {
    match s {
        None => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").map(Some).map_err(|_| SectError::Other(format!("--as-of `{s}` is not a date (YYYY-MM-DD)"))),
    }
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
                println!("{}", sect_format::json_value(&rep));
            } else {
                print!("{}", sect_format::build_text(&rep));
            }
            Ok(if rep.errors() > 0 { 1 } else { 0 })
        }
        Cmd::Read { id, ancestors, children, tables, history, as_of, version } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let opts = ReadOptions { ancestors, children, tables, history, as_of: parse_date(&as_of)?, version, include_superseded: cli.include_superseded };
            let r = sect_query::read(&index, &id, &opts)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::read_text(&r) });
            Ok(0)
        }
        Cmd::Map { scope, depth, budget, complete } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let r = sect_query::map(&index, scope.as_deref(), depth, budget, complete)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::map_text(&r) });
            Ok(0)
        }
        Cmd::Refs { id, direction, kind, depth, as_of } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let dir = Direction::parse(&direction).unwrap_or(Direction::Out);
            let r = sect_query::refs(&index, &id, dir, kind.as_deref(), depth, parse_date(&as_of)?, cli.include_superseded)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::refs_text(&r) });
            Ok(0)
        }
        Cmd::Define { term, usages, scope, as_of } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let r = sect_query::define(&index, &term, usages, scope.as_deref(), parse_date(&as_of)?)?;
            let defined = r.result.defined;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::define_text(&r) });
            Ok(if defined { 0 } else { 1 })
        }
        Cmd::Status => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let r = sect_query::status(&index)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::status_text(&r) });
            Ok(0)
        }
    }
}
