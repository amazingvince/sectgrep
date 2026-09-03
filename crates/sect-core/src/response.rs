//! Every verb answers with a header first: a freshness line and a counts line (spec B.1, B.3).

use serde::Serialize;

/// How a query treats a stale index (spec B.6): refresh small change sets synchronously and
/// large ones in the background (`Auto`), always refresh before answering (`Wait`), or answer
/// from the index as it is (`No`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Refresh {
    Auto,
    Wait,
    No,
}

impl Refresh {
    pub fn parse(s: &str) -> Option<Refresh> {
        match s {
            "auto" => Some(Refresh::Auto),
            "wait" => Some(Refresh::Wait),
            "no" | "none" | "off" => Some(Refresh::No),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Freshness {
    /// Index matches the files on disk. `rebuilt` is set when this query rebuilt it first:
    /// (changed files, milliseconds the rebuild took).
    Fresh { files: usize, built_at: String, rebuilt: Option<(usize, u64)>, stat_ms: u64 },
    /// Files changed since the index was built and the query did not refresh; `background` is
    /// true when a rebuild is running (or was just started) in another process.
    PossiblyStale { files: usize, changed: usize, built_at: String, background: bool, stat_ms: u64 },
    /// No index on disk.
    Missing,
}

impl Freshness {
    pub fn line(&self) -> String {
        match self {
            Freshness::Fresh { files, built_at, rebuilt: None, stat_ms } => {
                format!("freshness: fresh ({files} files indexed; stat {stat_ms} ms; built {built_at})")
            }
            Freshness::Fresh { files, rebuilt: Some((n, ms)), stat_ms, .. } => {
                format!("freshness: fresh (rebuilt after {n} changed file(s) in {ms} ms; {files} files indexed; stat {stat_ms} ms)")
            }
            Freshness::PossiblyStale { files, changed, built_at, background: true, stat_ms } => format!(
                "freshness: possibly_stale ({changed} of {files} files changed since {built_at}; rebuilding in background; stat {stat_ms} ms; use --freshness wait to block)"
            ),
            Freshness::PossiblyStale { files, changed, built_at, background: false, stat_ms } => format!(
                "freshness: possibly_stale ({changed} of {files} files changed since {built_at}; stat {stat_ms} ms; run `sect index` or use --freshness wait)"
            ),
            Freshness::Missing => "freshness: missing (no index; run `sect index <corpus>`)".to_string(),
        }
    }

    pub fn is_fresh(&self) -> bool {
        matches!(self, Freshness::Fresh { .. })
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Counts {
    /// Items in this response.
    pub shown: usize,
    /// Items that matched before bounding (equals `shown` when nothing was cut).
    pub matched: usize,
    pub works: usize,
    pub expressions: usize,
    pub superseded: usize,
    pub sources: usize,
    /// Extra `name=value` pairs a verb wants on the counts line (errors, warnings, unresolved refs).
    pub extra: Vec<(String, usize)>,
}

impl Counts {
    pub fn line(&self) -> String {
        let mut s = format!(
            "counts: {} shown of {} matched; {} works, {} expressions ({} superseded), {} sources",
            self.shown, self.matched, self.works, self.expressions, self.superseded, self.sources
        );
        for (k, v) in &self.extra {
            s.push_str(&format!("; {k} {v}"));
        }
        s
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Header {
    pub freshness: Freshness,
    pub counts: Counts,
}

impl Header {
    /// The two lines every response starts with.
    pub fn lines(&self) -> [String; 2] {
        [self.freshness.line(), self.counts.line()]
    }
}

/// A verb's answer: header first, then the verb-specific body.
#[derive(Debug, Clone, Serialize)]
pub struct Response<T: Serialize> {
    #[serde(flatten)]
    pub header: Header,
    pub result: T,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_start_with_the_right_prefixes() {
        let h = Header {
            freshness: Freshness::Fresh { files: 44, built_at: "2026-09-03T00:00:00Z".into(), rebuilt: None, stat_ms: 2 },
            counts: Counts { shown: 1, matched: 1, works: 43, expressions: 44, superseded: 1, sources: 4, extra: vec![] },
        };
        let [f, c] = h.lines();
        assert!(f.starts_with("freshness: fresh (44 files indexed; stat 2 ms"));
        assert!(c.starts_with("counts: 1 shown of 1 matched; 43 works"));
        let stale = Freshness::PossiblyStale { files: 44, changed: 30, built_at: "t".into(), background: true, stat_ms: 3 };
        assert!(stale.line().contains("rebuilding in background"));
        assert_eq!(Refresh::parse("wait"), Some(Refresh::Wait));
        assert_eq!(Refresh::parse("no"), Some(Refresh::No));
    }
}
