//! Deterministic retrieval spans. Source units and their identities never depend on this policy.
use sect_core::{Result, SectError};
use serde::{Deserialize, Serialize};

pub const RECIPE: &str = "coherent-passages-v5";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PassagePolicy {
    pub target: usize,
    pub max: usize,
}
impl Default for PassagePolicy {
    fn default() -> Self {
        Self {
            target: 512,
            max: 800,
        }
    }
}
impl PassagePolicy {
    pub fn validate(&self) -> Result<()> {
        if self.target < 64 || self.max < self.target || self.max > 8192 {
            return Err(SectError::Other(
                "passage budget requires 64 <= target <= max <= 8192".into(),
            ));
        }
        Ok(())
    }
}

pub struct Budget {
    pub policy: PassagePolicy,
    pub tokenizer: Option<sect_semantic::TokenCounter>,
}
impl Budget {
    pub fn count(&self, text: &str) -> Result<usize> {
        self.tokenizer
            .as_ref()
            .map_or_else(|| Ok(text.split_whitespace().count()), |t| t.count(text))
    }
    pub fn unit(&self) -> &'static str {
        if self.tokenizer.is_some() {
            "model_tokens"
        } else {
            "whitespace_words"
        }
    }
    /// Prefixes are retrieval metadata, never quoted source. Keep the nearest scope when a
    /// very deep breadcrumb consumes the budget. The full path remains separately available.
    pub fn prefix(&self, breadcrumb: &str, context: &str) -> Result<String> {
        let full = format!("{breadcrumb}\n{context}");
        let cap = self.policy.max / 3;
        if self.count(&full)? <= cap {
            return Ok(full);
        }
        let mut result = String::new();
        for part in breadcrumb.rsplit(" > ") {
            let candidate = if result.is_empty() {
                part.into()
            } else {
                format!("{part} > {result}")
            };
            if self.count(&candidate)? > cap {
                break;
            }
            result = candidate;
        }
        if result.is_empty() {
            let end = self.fitting_end(breadcrumb, "", cap)?;
            result.push_str(&breadcrumb[..end]);
        }
        Ok(result)
    }
    fn fitting_end(&self, body: &str, prefix: &str, max: usize) -> Result<usize> {
        if let Some(tokenizer) = &self.tokenizer {
            let input = format!("{prefix}\n{body}");
            let end = tokenizer
                .suggest_prefix_end(&input, max)?
                .saturating_sub(prefix.len() + 1)
                .min(body.len());
            // Offsets describe the original input, but token counts at a new end
            // can differ. Accept only a recounted, source-aligned candidate.
            if end > 0
                && body.is_char_boundary(end)
                && self.count(&format!("{prefix}\n{}", &body[..end]))? <= max
            {
                return Ok(end);
            }
        }
        let boundaries: Vec<usize> = body
            .char_indices()
            .map(|(i, _)| i)
            .chain([body.len()])
            .collect();
        let (mut lo, mut hi) = (0, boundaries.len());
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            if self.count(&format!("{prefix}\n{}", &body[..boundaries[mid]]))? <= max {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Token counts need not be monotonic as subwords merge. Binary search finds a
        // bounded prefix, not necessarily the longest one; correctness requires only the bound.
        Ok(boundaries[lo])
    }
    pub fn split(&self, body: &str, prefix: &str) -> Result<Vec<Part>> {
        self.split_at_boundaries(body, prefix, false)
    }
    /// Find a local window that exceeds the token budget, or reaches the source end.
    /// Counting the entire remaining section before every split made long provisions
    /// quadratic in source length. Grow by bytes, but decide only with the actual
    /// tokenizer and return UTF-8 boundaries. Eight bytes per token is an initial
    /// probe size, never a token estimate or a content limit.
    fn counting_window<'a>(&self, body: &'a str, prefix: &str) -> Result<(&'a str, usize)> {
        let mut probe = self.policy.max.saturating_mul(8).min(body.len());
        loop {
            let mut end = probe;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            let window = &body[..end];
            let count = self.count(&format!("{prefix}\n{window}"))?;
            if end == body.len() || count > self.policy.max {
                return Ok((window, count));
            }
            probe = probe.saturating_mul(2).min(body.len());
        }
    }
    pub fn split_at_boundaries(&self, body: &str, prefix: &str, table: bool) -> Result<Vec<Part>> {
        self.policy.validate()?;
        if self.count(prefix)? >= self.policy.max {
            return Err(SectError::Other(
                "passage prefix leaves no source-text budget".into(),
            ));
        }
        let mut out = Vec::new();
        let mut start = 0;
        while start < body.len() {
            let rest = &body[start..];
            let (window, size) = self.counting_window(rest, prefix)?;
            let mut fallback = false;
            let end = if size <= self.policy.max {
                body.len()
            } else {
                let fitting = self.fitting_end(window, prefix, self.policy.max)?;
                if fitting == 0 {
                    return Err(SectError::Other(
                        "a source character exceeds the passage budget".into(),
                    ));
                }
                let bounded = &rest[..fitting];
                let mut chosen = 0;
                // Prefer complete paragraphs, keeping list lead-ins with their items whenever
                // they fit. Do not split merely because a small section misses the target size.
                let separator = if table { "\n" } else { "\n\n" };
                for (i, _) in bounded.match_indices(separator) {
                    let boundary = i + separator.len();
                    if boundary > 0 {
                        chosen = boundary;
                        if self.count(&format!("{prefix}\n{}", &rest[..boundary]))?
                            >= self.policy.target
                        {
                            break;
                        }
                    }
                }
                if chosen == 0 {
                    for (i, ch) in bounded.char_indices() {
                        if matches!(ch, '.' | '!' | '?')
                            && rest[i + ch.len_utf8()..].starts_with(char::is_whitespace)
                        {
                            chosen = i + ch.len_utf8();
                        }
                    }
                }
                if chosen == 0 {
                    // Oversize sentences/rows retain exact contiguous UTF-8 ranges and a
                    // continuation marker. Prefer a word boundary to avoid broken display.
                    chosen = bounded
                        .char_indices()
                        .rev()
                        .find(|(_, c)| c.is_whitespace())
                        .map(|(i, c)| i + c.len_utf8())
                        .filter(|i| *i > 0)
                        .unwrap_or(fitting);
                    fallback = true;
                }
                start + chosen
            };
            let count = self.count(&format!("{prefix}\n{}", &body[start..end]))?;
            // Prefix tokenization at a chosen sentence boundary can differ from its enclosing
            // prefix; never rely on an assumed monotonic tokenizer or silently truncate.
            if count > self.policy.max {
                return Err(SectError::Other(
                    "passage boundary exceeds tokenizer budget".into(),
                ));
            }
            out.push(Part {
                start,
                end,
                count,
                fallback,
            });
            start = end;
        }
        if out.is_empty() {
            out.push(Part {
                start: 0,
                end: 0,
                count: self.count(prefix)?,
                fallback: false,
            });
        }
        Ok(out)
    }
}

#[derive(Debug)]
pub struct Part {
    pub start: usize,
    pub end: usize,
    pub count: usize,
    pub fallback: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokenizer_offsets_preserve_normalized_unicode_and_recount_expanding_characters() {
        let model = tempfile::tempdir().unwrap();
        std::fs::write(
            model.path().join("tokenizer.json"),
            r#"{
            "version":"1.0", "truncation":null, "padding":null, "added_tokens":[],
            "normalizer":{"type":"NFKC"}, "pre_tokenizer":{"type":"WhitespaceSplit"},
            "post_processor":null, "decoder":null,
            "model":{"type":"WordLevel","vocab":{"[UNK]":0},"unk_token":"[UNK]"}
        }"#,
        )
        .unwrap();
        let tokenizer = sect_semantic::TokenCounter::load(model.path().to_str().unwrap()).unwrap();
        let text = "cafe\u{301} 東京 ﬁancée e\u{301}lan";
        let end = tokenizer.suggest_prefix_end(text, 2).unwrap();
        assert_eq!(&text[..end], "cafe\u{301} 東京");
        assert_eq!(tokenizer.count(&text[..end]).unwrap(), 2);

        let budget = Budget {
            policy: PassagePolicy {
                target: 64,
                max: 81,
            },
            tokenizer: Some(tokenizer),
        };
        // NFKC expands this single source character to multiple words. Its offset
        // can suggest a prefix that exceeds the budget after standalone recount.
        let body = format!(
            "{}\n\nFinal exception: cafe\u{301} 東京 ﬁancée.",
            "ﷺ ".repeat(150)
        );
        let input = format!("Outer scope\n{body}");
        let suggested = budget
            .tokenizer
            .as_ref()
            .unwrap()
            .suggest_prefix_end(&input, 81)
            .unwrap();
        assert!(budget.count(&input[..suggested]).unwrap() > 81);
        let parts = budget.split(&body, "Outer scope").unwrap();
        assert!(parts.len() > 1);
        assert_eq!(
            parts
                .iter()
                .map(|part| &body[part.start..part.end])
                .collect::<String>(),
            body
        );
        for part in &parts {
            let actual = budget
                .count(&format!("Outer scope\n{}", &body[part.start..part.end]))
                .unwrap();
            assert_eq!(actual, part.count);
            assert!(actual <= 81);
        }
        assert!(body[parts.last().unwrap().start..].contains("Final exception"));
    }

    #[test]
    fn long_unlabelled_unicode_provisions_keep_every_byte_and_the_tail() {
        let budget = Budget {
            policy: PassagePolicy {
                target: 64,
                max: 80,
            },
            tokenizer: None,
        };
        let body = format!(
            "{}\n\nNever omit the final exception: café Δ 東京.",
            "A long sentence without punctuation ".repeat(140)
        );
        let parts = budget.split(&body, "Scope > title").unwrap();
        assert!(parts.len() > 2);
        assert_eq!(
            parts
                .iter()
                .map(|p| &body[p.start..p.end])
                .collect::<String>(),
            body
        );
        assert!(parts.iter().all(|p| p.count <= 80));
        assert!(parts.iter().any(|p| p.fallback));
        assert!(body[parts.last().unwrap().start..].contains("final exception"));

        // Oversized byte length alone does not justify splitting a coherent unit.
        // The probe must grow when unusually long words remain within the token budget.
        let long_word = "東京é".repeat(10_000);
        let parts = budget.split(&long_word, "Scope").unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(&long_word[parts[0].start..parts[0].end], long_word);

        // A large ordinary section starts with bounded local tokenization instead
        // of encoding its entire suffix before discovering the first passage.
        let large = "A source condition with Unicode café.\n\n".repeat(10_000);
        let (window, count) = budget.counting_window(&large, "Scope").unwrap();
        assert!(window.len() < large.len() / 100);
        assert!(count > budget.policy.max);
    }
    #[test]
    fn keeps_a_complete_provision_and_budgets_its_context() {
        let budget = Budget {
            policy: PassagePolicy {
                target: 64,
                max: 80,
            },
            tokenizer: None,
        };
        let body = "Definition.\n\nA requirement with a condition.\n\nException: two years only.";
        assert_eq!(budget.split(body, "A > B").unwrap().len(), 1);
        let prefix = budget
            .prefix(&"Very long title ".repeat(100), "context")
            .unwrap();
        assert!(budget.count(&prefix).unwrap() <= 26);
        assert!(budget
            .split(body, &prefix)
            .unwrap()
            .iter()
            .all(|p| p.count <= 80));
    }
}
