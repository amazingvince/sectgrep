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
        /// Embedding provider: `model2vec:<hub repo or local dir>` (default minishlab/potion-retrieval-32M), or `none`.
        #[arg(long, value_name = "SPEC")]
        embedding: Option<String>,
    },
    /// Ranked hybrid retrieval: BM25 + vector fused with RRF, one hit per section, bounded.
    Search {
        query: String,
        /// Lexical (BM25) only.
        #[arg(long)]
        fts: bool,
        /// Vector only.
        #[arg(long)]
        vector: bool,
        /// Fuse both legs (the default).
        #[arg(long)]
        fuse: bool,
        #[arg(long, value_name = "ID")]
        scope: Option<String>,
        #[arg(long, value_name = "NAME")]
        source: Option<String>,
        /// base | overlay | notice | internal | note
        #[arg(long, value_name = "KIND")]
        kind: Option<String>,
        #[arg(long, value_name = "DATE")]
        as_of: Option<String>,
        /// Hits to return (at most 50).
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// Append one-line summaries: `refs` (sections each hit references) or `ancestors`.
        #[arg(long, value_name = "refs|ancestors", value_parser = ["refs", "ancestors"])]
        expand: Option<String>,
        /// Lexical-heavy top-k as a compact context block for one-time injection at session start.
        #[arg(long)]
        seed: bool,
        /// Token budget for --seed.
        #[arg(long, default_value_t = 1500)]
        budget: usize,
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
    /// Exhaustive exact/regex search with ripgrep-compatible flags and output, bounded by --max-hits.
    Grep {
        /// Pattern (regex by default; -F for a literal). Use -e for several.
        #[arg(value_name = "PATTERN")]
        pattern: Option<String>,
        /// A pattern to search for; may be repeated.
        #[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
        regexp: Vec<String>,
        #[arg(short = 'i', long = "ignore-case")]
        ignore_case: bool,
        #[arg(short = 'w', long = "word-regexp")]
        word: bool,
        #[arg(short = 'F', long = "fixed-strings")]
        fixed_strings: bool,
        /// Include or exclude files by glob (gitignore semantics; `!` excludes). May be repeated.
        #[arg(short = 'g', long = "glob", value_name = "GLOB")]
        glob: Vec<String>,
        /// Show line numbers (the default).
        #[arg(short = 'n', long = "line-number")]
        line_number: bool,
        /// Suppress line numbers.
        #[arg(short = 'N', long = "no-line-number", conflicts_with = "line_number")]
        no_line_number: bool,
        /// Only print the count of matching lines per file.
        #[arg(short = 'c', long = "count")]
        count: bool,
        /// Only print the paths of files with at least one match.
        #[arg(short = 'l', long = "files-with-matches")]
        files_with_matches: bool,
        #[arg(short = 'A', long = "after-context", value_name = "NUM", default_value_t = 0)]
        after: usize,
        #[arg(short = 'B', long = "before-context", value_name = "NUM", default_value_t = 0)]
        before: usize,
        #[arg(short = 'C', long = "context", value_name = "NUM")]
        context: Option<usize>,
        /// Name the section and paragraph of every matched line.
        #[arg(long)]
        annotate: bool,
        /// Total and per-file counts only.
        #[arg(long)]
        count_only: bool,
        /// Beyond this many matching lines the answer is per-file counts (default 200).
        #[arg(long, default_value_t = sect_exact::DEFAULT_MAX_HITS)]
        max_hits: usize,
        /// Only search files of Works under this id.
        #[arg(long, value_name = "ID")]
        scope: Option<String>,
        /// Only search files of this source.
        #[arg(long, value_name = "NAME")]
        source: Option<String>,
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
        Cmd::Search { query, fts, vector, fuse, scope, source, kind, as_of, limit, expand, seed, budget } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let mode = match (fts, vector, fuse) {
                (true, false, false) => sect_query::SearchMode::Fts,
                (false, true, false) => sect_query::SearchMode::Vector,
                _ => sect_query::SearchMode::Fuse,
            };
            let opts = sect_query::SearchOptions { query, mode, scope, source, kind, as_of: parse_date(&as_of)?, include_superseded: cli.include_superseded, limit, expand: expand.as_deref().and_then(sect_query::Expand::parse), seed, budget };
            let r = sect_query::search(&index, &opts)?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::search_text(&r) });
            Ok(0)
        }
        Cmd::Index { path, full, validate_only, embedding } => {
            let root = path.unwrap_or(cli.corpus);
            let rep = sect_index::build(&root, &BuildOptions { full, validate_only, embedding })?;
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
        Cmd::Grep { pattern, regexp, ignore_case, word, fixed_strings, glob, line_number: _, no_line_number, count, files_with_matches, after, before, context, annotate, count_only, max_hits, scope, source } => {
            let index = sect_index::open(&cli.corpus, !cli.no_refresh)?;
            let mut patterns = regexp;
            if let Some(p) = pattern {
                patterns.insert(0, p);
            }
            let (before, after) = match context {
                Some(c) => (c.max(before), c.max(after)),
                None => (before, after),
            };
            let opts = sect_exact::GrepOptions { patterns, ignore_case, word, fixed_strings, globs: glob, before, after, count, files_with_matches, count_only, max_hits, only_paths: None };
            let r = sect_query::grep(&index, &opts, annotate, scope.as_deref(), source.as_deref())?;
            print!("{}", if cli.json { sect_format::json(&r) + "\n" } else { sect_format::grep_text(&r, !no_line_number) });
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
