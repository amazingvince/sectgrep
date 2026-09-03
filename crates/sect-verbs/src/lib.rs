//! The seven verbs (and the two admin verbs) as one set of argument definitions and one runner.
//!
//! Each `*Args` struct derives `clap::Args` for the CLI and `schemars::JsonSchema` plus
//! `serde::Deserialize` for the MCP server, so the tool schemas an agent sees are generated
//! from the same definitions the CLI parses (spec B.3). Doc comments are the help text and the
//! schema descriptions. The runner returns the text rendering (what the CLI prints) and the
//! JSON rendering (what `--json` prints) together; the MCP server hands both to the client.

use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use clap::{Args, Subcommand};
use schemars::JsonSchema;
use sect_core::{Refresh, Result, SectError};
use sect_index::{BuildOptions, Index};
use sect_query::{Expand, ReadOptions, SearchMode, SearchOptions};
use sect_struct::Direction;
use serde::Deserialize;

pub const DESC_SEARCH: &str = "Ranked hybrid retrieval over the corpus: BM25 and embeddings fused with RRF, one hit per section, at most 50. A citation (\"99 CFR 2.8\") or a definition question (\"what is a hole\") is answered structurally first. Start here for any question in prose.";
pub const DESC_READ: &str = "Show a section by Work id, Expression id, or id#anchor, with structural context; --as-of snaps to the text in force on a date, --history lists every version and the Actions between them.";
pub const DESC_MAP: &str = "Table of contents under a scope, bounded by a token budget; complete=true returns the whole subtree by traversal (sections under a container, paragraphs under a section).";
pub const DESC_REFS: &str = "Cross-reference and amendment traversal: what points at this section, what it points to, filtered by edge type (references, overrides, narrows, supersedes, amends, defines).";
pub const DESC_DEFINE: &str = "Defined-term lookup by structural resolution: the defining section and paragraph, optionally the sections that use the term.";
pub const DESC_GREP: &str = "Exhaustive exact or regex search with ripgrep-compatible flags and path:line:text output, bounded by max_hits; beyond the bound the answer is per-file counts.";
pub const DESC_STATUS: &str = "Freshness, counts, warnings, unresolved references, and the legal-status summary of the corpus.";
pub const DESC_INDEX: &str = "Admin: build or refresh the index (incremental; validate_only checks the B.2 contract and writes nothing).";
pub const DESC_REBUILD: &str = "Admin: rebuild every index layer from scratch, ignoring stored fingerprints.";

fn d_limit() -> usize {
    10
}
fn d_budget() -> usize {
    1500
}
fn d_depth3() -> usize {
    3
}
fn d_one() -> usize {
    1
}
fn d_out() -> String {
    "out".into()
}
fn d_max_hits() -> usize {
    sect_exact::DEFAULT_MAX_HITS
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    /// The question or phrase to search for.
    pub query: String,
    /// Lexical (BM25) only.
    #[arg(long)]
    #[serde(default)]
    pub fts: bool,
    /// Vector only.
    #[arg(long)]
    #[serde(default)]
    pub vector: bool,
    /// Fuse both legs (the default).
    #[arg(long)]
    #[serde(default)]
    pub fuse: bool,
    /// Only sections under this Work id.
    #[arg(long, value_name = "ID")]
    pub scope: Option<String>,
    /// Only sections of this source.
    #[arg(long, value_name = "NAME")]
    pub source: Option<String>,
    /// base | overlay | notice | internal | note
    #[arg(long, value_name = "KIND")]
    pub kind: Option<String>,
    /// Only text in force on this date (YYYY-MM-DD).
    #[arg(long, value_name = "DATE")]
    pub as_of: Option<String>,
    /// Hits to return (at most 50).
    #[arg(long, default_value_t = 10)]
    #[serde(default = "d_limit")]
    pub limit: usize,
    /// Append one-line summaries: `refs` (sections each hit references) or `ancestors`.
    #[arg(long, value_name = "refs|ancestors", value_parser = ["refs", "ancestors"])]
    pub expand: Option<String>,
    /// Lexical-heavy top-k as a compact context block for one-time injection at session start.
    #[arg(long)]
    #[serde(default)]
    pub seed: bool,
    /// Token budget for seed.
    #[arg(long, default_value_t = 1500)]
    #[serde(default = "d_budget")]
    pub budget: usize,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadArgs {
    /// Work id, Expression id, or id#anchor.
    pub id: String,
    /// Include the chain of ancestors.
    #[arg(long)]
    #[serde(default)]
    pub ancestors: bool,
    /// Include the direct children.
    #[arg(long)]
    #[serde(default)]
    pub children: bool,
    /// Include the section's tables as structured rows.
    #[arg(long)]
    #[serde(default)]
    pub tables: bool,
    /// List every Expression of the Work and the Actions between them.
    #[arg(long)]
    #[serde(default)]
    pub history: bool,
    /// Snap to the Expression in force on this date (YYYY-MM-DD).
    #[arg(long, value_name = "DATE")]
    pub as_of: Option<String>,
    /// Read a specific Expression id.
    #[arg(long, value_name = "EXPR")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MapArgs {
    /// Root of the listing: a Work id, or id#anchor for paragraphs.
    #[arg(long, value_name = "ID[#anchor]")]
    pub scope: Option<String>,
    /// Levels below the scope to show.
    #[arg(long, default_value_t = 3)]
    #[serde(default = "d_depth3")]
    pub depth: usize,
    /// Token budget for the listing.
    #[arg(long, default_value_t = 1500)]
    #[serde(default = "d_budget")]
    pub budget: usize,
    /// Full subtree by traversal (sections under a container, paragraphs under a section).
    #[arg(long)]
    #[serde(default)]
    pub complete: bool,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RefsArgs {
    /// The section to start from.
    pub id: String,
    /// in | out | both
    #[arg(long, default_value = "out", value_parser = ["in", "out", "both"])]
    #[serde(default = "d_out")]
    pub direction: String,
    /// references | overrides | narrows | supersedes | amends | defines
    #[arg(long = "type", value_name = "TYPE")]
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// Hops to follow (at most 5).
    #[arg(long, default_value_t = 1)]
    #[serde(default = "d_one")]
    pub depth: usize,
    /// Only edges from text in force on this date (YYYY-MM-DD).
    #[arg(long, value_name = "DATE")]
    pub as_of: Option<String>,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DefineArgs {
    /// The term to resolve.
    pub term: String,
    /// List the sections that use the term.
    #[arg(long)]
    #[serde(default)]
    pub usages: bool,
    /// Limit usages to a subtree.
    #[arg(long, value_name = "ID")]
    pub scope: Option<String>,
    /// Only definitions in force on this date (YYYY-MM-DD).
    #[arg(long, value_name = "DATE")]
    pub as_of: Option<String>,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GrepArgs {
    /// Pattern (regex by default; fixed_strings for a literal). Use regexp for several.
    #[arg(value_name = "PATTERN")]
    pub pattern: Option<String>,
    /// A pattern to search for; may be repeated.
    #[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
    #[serde(default)]
    pub regexp: Vec<String>,
    /// Case-insensitive.
    #[arg(short = 'i', long = "ignore-case")]
    #[serde(default)]
    pub ignore_case: bool,
    /// Match whole words.
    #[arg(short = 'w', long = "word-regexp")]
    #[serde(default)]
    pub word: bool,
    /// Treat the pattern as a literal string.
    #[arg(short = 'F', long = "fixed-strings")]
    #[serde(default)]
    pub fixed_strings: bool,
    /// Include or exclude files by glob (gitignore semantics; `!` excludes). May be repeated.
    #[arg(short = 'g', long = "glob", value_name = "GLOB")]
    #[serde(default)]
    pub glob: Vec<String>,
    /// Show line numbers (the default).
    #[arg(short = 'n', long = "line-number")]
    #[serde(default)]
    pub line_number: bool,
    /// Suppress line numbers.
    #[arg(short = 'N', long = "no-line-number", conflicts_with = "line_number")]
    #[serde(default)]
    pub no_line_number: bool,
    /// Only print the count of matching lines per file.
    #[arg(short = 'c', long = "count")]
    #[serde(default)]
    pub count: bool,
    /// Only print the paths of files with at least one match.
    #[arg(short = 'l', long = "files-with-matches")]
    #[serde(default)]
    pub files_with_matches: bool,
    /// Lines of context after each match.
    #[arg(short = 'A', long = "after-context", value_name = "NUM", default_value_t = 0)]
    #[serde(default)]
    pub after: usize,
    /// Lines of context before each match.
    #[arg(short = 'B', long = "before-context", value_name = "NUM", default_value_t = 0)]
    #[serde(default)]
    pub before: usize,
    /// Lines of context on both sides.
    #[arg(short = 'C', long = "context", value_name = "NUM")]
    pub context: Option<usize>,
    /// Name the section and paragraph of every matched line.
    #[arg(long)]
    #[serde(default)]
    pub annotate: bool,
    /// Total and per-file counts only.
    #[arg(long)]
    #[serde(default)]
    pub count_only: bool,
    /// Beyond this many matching lines the answer is per-file counts (default 200).
    #[arg(long, default_value_t = sect_exact::DEFAULT_MAX_HITS)]
    #[serde(default = "d_max_hits")]
    pub max_hits: usize,
    /// Only search files of Works under this id.
    #[arg(long, value_name = "ID")]
    pub scope: Option<String>,
    /// Only search files of this source.
    #[arg(long, value_name = "NAME")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StatusArgs {}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IndexArgs {
    /// Corpus root (overrides --corpus).
    pub path: Option<PathBuf>,
    /// Re-hash every file and rebuild every layer instead of trusting stored fingerprints.
    #[arg(long)]
    #[serde(default)]
    pub full: bool,
    /// Check the B.2 contract only; write nothing. Exit 1 on errors.
    #[arg(long)]
    #[serde(default)]
    pub validate_only: bool,
    /// Embedding provider: `model2vec:<hub repo or local dir>` (default minishlab/potion-retrieval-32M), or `none`.
    #[arg(long, value_name = "SPEC")]
    pub embedding: Option<String>,
}

#[derive(Debug, Clone, Default, Args, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RebuildArgs {
    /// Embedding provider for the rebuilt semantic layer (default: what the index was built with).
    #[arg(long, value_name = "SPEC")]
    pub embedding: Option<String>,
}

/// The verbs as CLI subcommands. The MCP server exposes the same structs as tool parameters.
#[derive(Debug, Clone, Subcommand)]
pub enum Verb {
    #[command(about = DESC_INDEX)]
    Index(IndexArgs),
    #[command(about = DESC_SEARCH)]
    Search(SearchArgs),
    #[command(about = DESC_READ)]
    Read(ReadArgs),
    #[command(about = DESC_MAP)]
    Map(MapArgs),
    #[command(about = DESC_REFS)]
    Refs(RefsArgs),
    #[command(about = DESC_DEFINE)]
    Define(DefineArgs),
    #[command(about = DESC_GREP)]
    Grep(GrepArgs),
    #[command(about = DESC_STATUS)]
    Status(StatusArgs),
}

/// Tool name and description for every verb, in the order agents should learn them.
pub const TOOLS: &[(&str, &str)] = &[
    ("sect_search", DESC_SEARCH),
    ("sect_grep", DESC_GREP),
    ("sect_read", DESC_READ),
    ("sect_refs", DESC_REFS),
    ("sect_define", DESC_DEFINE),
    ("sect_map", DESC_MAP),
    ("sect_status", DESC_STATUS),
];
pub const ADMIN_TOOLS: &[(&str, &str)] = &[("sect_index", DESC_INDEX), ("sect_rebuild", DESC_REBUILD)];

/// What a verb produced: the text the CLI prints, the JSON `--json` prints, and the exit code.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub text: String,
    pub json: serde_json::Value,
    pub exit: i32,
}

fn outcome<T: serde::Serialize>(r: &sect_core::Response<T>, text: String, exit: i32) -> Result<Outcome> {
    Ok(Outcome { text, json: serde_json::to_value(r)?, exit })
}

pub fn parse_date(s: &Option<String>) -> Result<Option<NaiveDate>> {
    match s {
        None => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").map(Some).map_err(|_| SectError::Other(format!("bad date {s:?}, expected YYYY-MM-DD"))),
    }
}

/// Open the index with the freshness policy (spec B.6: every query stats the tree first).
pub fn open(corpus: &Path, policy: Refresh) -> Result<Index> {
    sect_index::open(corpus, policy)
}

pub fn search(index: &Index, a: &SearchArgs, include_superseded: bool) -> Result<Outcome> {
    let mode = match (a.fts, a.vector, a.fuse) {
        (true, false, false) => SearchMode::Fts,
        (false, true, false) => SearchMode::Vector,
        _ => SearchMode::Fuse,
    };
    let opts = SearchOptions {
        query: a.query.clone(),
        mode,
        scope: a.scope.clone(),
        source: a.source.clone(),
        kind: a.kind.clone(),
        as_of: parse_date(&a.as_of)?,
        include_superseded,
        limit: a.limit,
        expand: a.expand.as_deref().and_then(Expand::parse),
        seed: a.seed,
        budget: a.budget,
    };
    let r = sect_query::search(index, &opts)?;
    outcome(&r, sect_format::search_text(&r), 0)
}

pub fn read(index: &Index, a: &ReadArgs, include_superseded: bool) -> Result<Outcome> {
    let opts = ReadOptions { ancestors: a.ancestors, children: a.children, tables: a.tables, history: a.history, as_of: parse_date(&a.as_of)?, version: a.version.clone(), include_superseded };
    let r = sect_query::read(index, &a.id, &opts)?;
    outcome(&r, sect_format::read_text(&r), 0)
}

pub fn map(index: &Index, a: &MapArgs) -> Result<Outcome> {
    let r = sect_query::map(index, a.scope.as_deref(), a.depth, a.budget, a.complete)?;
    outcome(&r, sect_format::map_text(&r), 0)
}

pub fn refs(index: &Index, a: &RefsArgs, include_superseded: bool) -> Result<Outcome> {
    let dir = Direction::parse(&a.direction).ok_or_else(|| SectError::Other(format!("bad direction {:?}: in, out, or both", a.direction)))?;
    let r = sect_query::refs(index, &a.id, dir, a.kind.as_deref(), a.depth, parse_date(&a.as_of)?, include_superseded)?;
    outcome(&r, sect_format::refs_text(&r), 0)
}

pub fn define(index: &Index, a: &DefineArgs) -> Result<Outcome> {
    let r = sect_query::define(index, &a.term, a.usages, a.scope.as_deref(), parse_date(&a.as_of)?)?;
    let exit = if r.result.defined { 0 } else { 1 };
    outcome(&r, sect_format::define_text(&r), exit)
}

pub fn grep(index: &Index, a: &GrepArgs) -> Result<Outcome> {
    let mut patterns = a.regexp.clone();
    if let Some(p) = &a.pattern {
        patterns.insert(0, p.clone());
    }
    if patterns.is_empty() {
        return Err(SectError::Other("grep needs a pattern".into()));
    }
    let (before, after) = match a.context {
        Some(c) => (c.max(a.before), c.max(a.after)),
        None => (a.before, a.after),
    };
    let opts = sect_exact::GrepOptions {
        patterns,
        ignore_case: a.ignore_case,
        word: a.word,
        fixed_strings: a.fixed_strings,
        globs: a.glob.clone(),
        before,
        after,
        count: a.count,
        files_with_matches: a.files_with_matches,
        count_only: a.count_only,
        max_hits: a.max_hits,
        only_paths: None,
    };
    let r = sect_query::grep(index, &opts, a.annotate, a.scope.as_deref(), a.source.as_deref())?;
    outcome(&r, sect_format::grep_text(&r, !a.no_line_number), 0)
}

pub fn status(index: &Index) -> Result<Outcome> {
    let r = sect_query::status(index)?;
    outcome(&r, sect_format::status_text(&r), 0)
}

/// `index` builds or refreshes; `rebuild` is `index --full`.
pub fn index(corpus: &Path, a: &IndexArgs) -> Result<Outcome> {
    let root = a.path.clone().unwrap_or_else(|| corpus.to_path_buf());
    let rep = sect_index::build(&root, &BuildOptions { full: a.full, validate_only: a.validate_only, embedding: a.embedding.clone() })?;
    Ok(Outcome { text: sect_format::build_text(&rep), json: serde_json::to_value(&rep)?, exit: if rep.errors() > 0 { 1 } else { 0 } })
}

pub fn rebuild(corpus: &Path, a: &RebuildArgs) -> Result<Outcome> {
    index(corpus, &IndexArgs { path: None, full: true, validate_only: false, embedding: a.embedding.clone() })
}

/// Run one verb against a corpus: open the index under the freshness policy, then dispatch.
pub fn run(corpus: &Path, policy: Refresh, include_superseded: bool, verb: &Verb) -> Result<Outcome> {
    if let Verb::Index(a) = verb {
        return index(corpus, a);
    }
    let ix = open(corpus, policy)?;
    match verb {
        Verb::Index(_) => unreachable!(),
        Verb::Search(a) => search(&ix, a, include_superseded),
        Verb::Read(a) => read(&ix, a, include_superseded),
        Verb::Map(a) => map(&ix, a),
        Verb::Refs(a) => refs(&ix, a, include_superseded),
        Verb::Define(a) => define(&ix, a),
        Verb::Grep(a) => grep(&ix, a),
        Verb::Status(_) => status(&ix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_mark_required_fields_and_reject_unknown_ones() {
        let s = serde_json::to_value(schemars::schema_for!(SearchArgs)).unwrap();
        assert_eq!(s["required"], serde_json::json!(["query"]), "{s}");
        assert!(s["properties"]["limit"]["description"].as_str().unwrap().contains("at most 50"));
        let r = serde_json::to_value(schemars::schema_for!(RefsArgs)).unwrap();
        assert!(r["properties"].get("type").is_some(), "kind is exposed as `type`, like the CLI flag: {r}");
        let a: SearchArgs = serde_json::from_str(r#"{"query":"cages","limit":3}"#).unwrap();
        assert_eq!((a.limit, a.budget, a.seed), (3, 1500, false));
        assert!(serde_json::from_str::<SearchArgs>(r#"{"query":"x","nope":1}"#).is_err());
        let g: GrepArgs = serde_json::from_str(r#"{"pattern":"cage","ignore_case":true}"#).unwrap();
        assert_eq!(g.max_hits, sect_exact::DEFAULT_MAX_HITS);
        assert_eq!(TOOLS.len(), 7);
    }
}
