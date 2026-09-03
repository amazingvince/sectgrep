//! Every verb answers with a header first: a freshness line and a counts line (spec B.1, B.3).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Freshness {
    /// Index matches the files on disk. `rebuilt` is set when this query rebuilt it first.
    Fresh { files: usize, built_at: String, rebuilt: Option<usize> },
    /// Files changed since the index was built and the query did not refresh.
    PossiblyStale { files: usize, changed: usize, built_at: String },
    /// No index on disk.
    Missing,
}

impl Freshness {
    pub fn line(&self) -> String {
        match self {
            Freshness::Fresh { files, built_at, rebuilt: None } => {
                format!("freshness: fresh ({files} files indexed; built {built_at})")
            }
            Freshness::Fresh { files, rebuilt: Some(n), .. } => {
                format!("freshness: fresh (rebuilt after {n} changed file(s); {files} files indexed)")
            }
            Freshness::PossiblyStale { files, changed, built_at } => format!(
                "freshness: possibly_stale ({changed} of {files} files changed since {built_at}; run `sect index` or drop --no-refresh)"
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
            freshness: Freshness::Fresh { files: 44, built_at: "2026-09-03T00:00:00Z".into(), rebuilt: None },
            counts: Counts { shown: 1, matched: 1, works: 43, expressions: 44, superseded: 1, sources: 4, extra: vec![] },
        };
        let [f, c] = h.lines();
        assert!(f.starts_with("freshness: fresh"));
        assert!(c.starts_with("counts: 1 shown of 1 matched; 43 works"));
    }
}
