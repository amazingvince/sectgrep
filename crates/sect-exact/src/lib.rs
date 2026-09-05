//! `sect grep` (spec B.3, B.4 "Exact"): exhaustive exact and regex search over the corpus files on
//! ripgrep's own crates. Output is ripgrep-compatible (`path:line:text`, context lines with `-`,
//! `--` between groups, `path:count` for counts) and bounded by `--max-hits`: beyond the bound the
//! answer is per-file counts and an instruction to narrow. The sparse n-gram prefilter of
//! milestone 3b slots in before the searcher; until then every file is scanned.

use std::path::{Path, PathBuf};

use globset::Glob;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use sect_core::{Result, SectError};
use serde::Serialize;

pub const DEFAULT_MAX_HITS: usize = 200;

#[derive(Debug, Clone)]
pub struct GrepOptions {
    pub patterns: Vec<String>,
    /// `-i`
    pub ignore_case: bool,
    /// `-w`
    pub word: bool,
    /// `-F`
    pub fixed_strings: bool,
    /// `-g`, gitignore-style; a leading `!` excludes.
    pub globs: Vec<String>,
    /// `-B`
    pub before: usize,
    /// `-A`
    pub after: usize,
    /// `-c`: per-file match counts instead of lines.
    pub count: bool,
    /// `-l`: only the paths of files with a match.
    pub files_with_matches: bool,
    /// `--count-only`: total and per-file counts, no lines.
    pub count_only: bool,
    /// `--max-hits`: at most this many matching lines are returned; beyond it, per-file counts.
    pub max_hits: usize,
    /// Restrict the search to these corpus-relative paths (for `--scope` / `--source`).
    pub only_paths: Option<Vec<String>>,
    /// Search exactly these files (relative paths, in walk order) instead of walking the tree;
    /// `globs` still apply. Set by the n-gram prefilter, whose list is the walk of a fresh index.
    pub files: Option<Vec<String>>,
}

impl Default for GrepOptions {
    fn default() -> Self {
        GrepOptions {
            patterns: vec![],
            ignore_case: false,
            word: false,
            fixed_strings: false,
            globs: vec![],
            before: 0,
            after: 0,
            count: false,
            files_with_matches: false,
            count_only: false,
            max_hits: DEFAULT_MAX_HITS,
            only_paths: None,
            files: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Match,
    Context,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrepLine {
    pub path: String,
    pub line: u64,
    pub kind: LineKind,
    pub text: String,
    /// True when ripgrep would print a `--` separator before this line.
    pub break_before: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileCount {
    pub path: String,
    pub matches: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct GrepOutput {
    pub lines: Vec<GrepLine>,
    pub per_file: Vec<FileCount>,
    pub files_searched: usize,
    pub files_matched: usize,
    /// Matching lines across all files, before bounding.
    pub total_matches: usize,
    pub truncated: bool,
    pub max_hits: usize,
    /// Files the walk found before any path restriction.
    pub files_total: usize,
}

pub fn build_matcher(opts: &GrepOptions) -> Result<RegexMatcher> {
    if opts.patterns.is_empty() {
        return Err(SectError::Other(
            "grep needs a pattern (positional or -e)".into(),
        ));
    }
    let mut b = RegexMatcherBuilder::new();
    b.case_insensitive(opts.ignore_case)
        .word(opts.word)
        .fixed_strings(opts.fixed_strings)
        .line_terminator(Some(b'\n'));
    b.build_many(&opts.patterns)
        .map_err(|e| SectError::Other(format!("regex: {e}")))
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Files ripgrep would search under `root`: hidden and gitignored entries skipped, `-g` globs
/// applied with gitignore semantics, siblings sorted by path (what `rg --sort path` does).
fn overrides_for(root: &Path, globs: &[String]) -> Result<ignore::overrides::Override> {
    let mut ob = OverrideBuilder::new(root);
    for g in globs {
        Glob::new(g.trim_start_matches('!'))
            .map_err(|e| SectError::Other(format!("glob `{g}`: {e}")))?;
        ob.add(g)
            .map_err(|e| SectError::Other(format!("glob `{g}`: {e}")))?;
    }
    ob.build()
        .map_err(|e| SectError::Other(format!("globs: {e}")))
}

/// The files to search: an explicit list filtered by the globs, or the walk.
fn resolve_files(root: &Path, opts: &GrepOptions) -> Result<Vec<(String, PathBuf)>> {
    let Some(list) = &opts.files else {
        return list_files(root, &opts.globs);
    };
    let ov = overrides_for(root, &opts.globs)?;
    Ok(list
        .iter()
        .filter(|rel| {
            if ov.is_empty() {
                return true;
            }
            match ov.matched(root.join(rel), false) {
                ignore::Match::Whitelist(_) => true,
                ignore::Match::Ignore(_) => false,
                ignore::Match::None => ov.num_whitelists() == 0,
            }
        })
        .map(|rel| (rel.clone(), root.join(rel)))
        .collect())
}

pub fn list_files(root: &Path, globs: &[String]) -> Result<Vec<(String, PathBuf)>> {
    list_files_excluding(root, globs, &[])
}

/// Prune generated export directories before walking, rather than statting every export.
pub fn list_files_excluding(
    root: &Path,
    globs: &[String],
    excluded: &[PathBuf],
) -> Result<Vec<(String, PathBuf)>> {
    let overrides = overrides_for(root, globs)?;
    let mut out = Vec::new();
    let excluded = excluded.to_vec();
    for entry in WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .filter_entry(move |e| !excluded.iter().any(|p| e.path().starts_with(p)))
        .overrides(overrides)
        .sort_by_file_path(|a, b| a.cmp(b))
        .build()
    {
        let entry = entry.map_err(|e| SectError::Other(format!("walk {}: {e}", root.display())))?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push((rel(root, entry.path()), entry.path().to_path_buf()));
        }
    }
    Ok(out)
}

struct Collector<'a> {
    path: &'a str,
    lines: &'a mut Vec<GrepLine>,
    matches: usize,
    want_lines: bool,
    budget: &'a mut usize,
    pending_break: bool,
}

fn strip_eol(b: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(b).to_string();
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    s
}

impl Sink for Collector<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        m: &SinkMatch<'_>,
    ) -> std::result::Result<bool, Self::Error> {
        self.matches += 1;
        if self.want_lines && *self.budget > 0 {
            *self.budget -= 1;
            self.lines.push(GrepLine {
                path: self.path.to_string(),
                line: m.line_number().unwrap_or(0),
                kind: LineKind::Match,
                text: strip_eol(m.bytes()),
                break_before: std::mem::take(&mut self.pending_break),
            });
        }
        Ok(true)
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        c: &SinkContext<'_>,
    ) -> std::result::Result<bool, Self::Error> {
        if self.want_lines && *self.budget > 0 {
            self.lines.push(GrepLine {
                path: self.path.to_string(),
                line: c.line_number().unwrap_or(0),
                kind: LineKind::Context,
                text: strip_eol(c.bytes()),
                break_before: std::mem::take(&mut self.pending_break),
            });
        }
        Ok(true)
    }

    fn context_break(&mut self, _searcher: &Searcher) -> std::result::Result<bool, Self::Error> {
        self.pending_break = true;
        Ok(true)
    }
}

/// Search every file under `root`. Exhaustive: every file is scanned even after `max_hits` is
/// reached so the per-file counts are complete.
pub fn grep(root: &Path, opts: &GrepOptions) -> Result<GrepOutput> {
    let files = resolve_files(root, opts)?
        .into_iter()
        .map(|(p, a)| (p, Content::Path(a)))
        .collect();
    grep_contents(root, opts, files)
}

pub enum Content<'a> {
    Path(PathBuf),
    Bytes(&'a [u8]),
}

/// The same exhaustive matcher and output contract for physical and mapped virtual files.
pub fn grep_contents(
    root: &Path,
    opts: &GrepOptions,
    mut files: Vec<(String, Content<'_>)>,
) -> Result<GrepOutput> {
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut selection = opts.clone();
    let candidates: Option<std::collections::HashSet<&str>> = opts
        .files
        .as_ref()
        .map(|f| f.iter().map(String::as_str).collect());
    selection.files = Some(
        files
            .iter()
            .filter(|(p, _)| candidates.as_ref().is_none_or(|f| f.contains(p.as_str())))
            .map(|(p, _)| p.clone())
            .collect(),
    );
    let allowed: std::collections::HashSet<_> = resolve_files(root, &selection)?
        .into_iter()
        .map(|(p, _)| p)
        .collect();
    let matcher = build_matcher(opts)?;
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .before_context(opts.before)
        .after_context(opts.after)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .build();
    let max_hits = if opts.max_hits == 0 {
        DEFAULT_MAX_HITS
    } else {
        opts.max_hits
    };
    let want_lines = !(opts.count || opts.files_with_matches || opts.count_only);
    let context = opts.before > 0 || opts.after > 0;
    let mut out = GrepOutput {
        max_hits,
        ..Default::default()
    };
    // One more than the bound so we can tell "exactly max_hits" from "more than max_hits".
    let mut budget = max_hits + 1;
    let only: Option<std::collections::HashSet<&str>> = opts
        .only_paths
        .as_ref()
        .map(|v| v.iter().map(|s| s.as_str()).collect());
    for (rel, content) in files {
        if !allowed.contains(&rel) {
            continue;
        }
        out.files_total += 1;
        if let Some(only) = &only {
            if !only.contains(rel.as_str()) {
                continue;
            }
        }
        out.files_searched += 1;
        let start = out.lines.len();
        let matches = {
            let mut c = Collector {
                path: &rel,
                lines: &mut out.lines,
                matches: 0,
                want_lines,
                budget: &mut budget,
                pending_break: false,
            };
            match content {
                Content::Path(abs) => searcher
                    .search_path(&matcher, &abs, &mut c)
                    .map_err(|e| SectError::io(&abs, e))?,
                Content::Bytes(bytes) => searcher
                    .search_slice(&matcher, bytes, &mut c)
                    .map_err(|e| SectError::io(&rel, e))?,
            }
            c.matches
        };
        if matches > 0 {
            out.files_matched += 1;
            out.total_matches += matches;
            out.per_file.push(FileCount {
                path: rel.clone(),
                matches,
            });
            if context && start > 0 && out.lines.len() > start {
                out.lines[start].break_before = true;
            }
        }
    }
    if out.total_matches > max_hits {
        out.truncated = true;
        out.lines.clear();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/corpus")
    }

    #[test]
    fn finds_lines_and_counts() {
        let o = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["toeboard".into()],
                ignore_case: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(o.files_searched >= 44);
        assert!(o.files_matched >= 3, "{:?}", o.per_file);
        assert!(o
            .lines
            .iter()
            .all(|l| l.text.to_lowercase().contains("toeboard")));
        assert!(!o.truncated);
        let counts = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["toeboard".into()],
                ignore_case: true,
                count: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(counts.lines.is_empty());
        assert_eq!(counts.per_file.len(), o.per_file.len());
    }

    #[test]
    fn bounds_at_max_hits_with_per_file_counts() {
        let o = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["the".into()],
                max_hits: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(o.truncated);
        assert!(o.lines.is_empty());
        assert!(o.total_matches > 10);
        assert_eq!(
            o.per_file.iter().map(|f| f.matches).sum::<usize>(),
            o.total_matches
        );
    }

    #[test]
    fn globs_and_word_and_fixed() {
        let o = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["kind:".into()],
                globs: vec!["*.yaml".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            o.lines.iter().all(|l| l.path.ends_with("_source.yaml")),
            "{:?}",
            o.lines
        );
        let o = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["(a)".into()],
                fixed_strings: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(o.total_matches > 20);
        let w = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["rail".into()],
                word: true,
                ..Default::default()
            },
        )
        .unwrap();
        let nw = grep(
            &fixture(),
            &GrepOptions {
                patterns: vec!["rail".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(w.total_matches < nw.total_matches);
    }
}
