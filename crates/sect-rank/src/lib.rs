//! Fusion and rerank (spec B.4 "Fusion / rerank"): BM25 top-100 + vector top-100 -> RRF (k = 60,
//! the `rrf` crate) -> the signal table -> one hit per section. Scores are RRF normalized so that
//! rank 1 in every list equals 1.0, and the signals are additive on that scale (decisions #20).
//!
//! | Signal | Rule | Here |
//! |---|---|---|
//! | Citation short-circuit | query matches `id_pattern` -> direct lookup, rank 1 | pinned by the caller |
//! | Adaptive lexical weight | ID/term-like query -> BM25 x2 | [`term_like`], `weights` |
//! | Definition resolution | define-shaped query -> defining section first | pinned by the caller |
//! | Title/path match | query tokens in title or breadcrumb | `+0.10 x fraction matched` |
//! | Section coherence | >= 3 chunks from one section -> collapse, boost best | `+0.10` |
//! | Hub boost | `log(1 + refs_in) x 0.02`, cap 0.10 | [`hub_boost`] |
//! | Superseded | filtered at as-of, or -0.5 if included | `-0.5` |
//! | Notes penalty | `kind: note` -0.2 | `-0.2` |
//! | Abstention | nothing above the confidence floor -> "not found" + nearest scope | [`should_abstain`] |

use std::collections::HashMap;

use serde::Serialize;

pub const RRF_K: usize = 60;
pub const TITLE_PATH_BOOST: f64 = 0.10;
pub const COHERENCE_BOOST: f64 = 0.10;
pub const COHERENCE_MIN_CHUNKS: usize = 3;
pub const HUB_SCALE: f64 = 0.02;
pub const HUB_CAP: f64 = 0.10;
pub const NOTE_PENALTY: f64 = -0.20;
pub const SUPERSEDED_PENALTY: f64 = -0.50;
pub const LEXICAL_WEIGHT_TERM_LIKE: f64 = 2.0;
pub const LEXICAL_WEIGHT_SEED: f64 = 3.0;

/// Abstention floors: lexical overlap of query content terms with the top hit, and the top
/// cosine. Below both, or below the hard cosine floor alone, the answer is "not found".
/// Calibrated on the fixture with potion-retrieval-32M: no valid, unpinned question scored a
/// top cosine under 0.30 except one that also failed the overlap floor, while every off-corpus
/// control scored under 0.28 or lacked lexical overlap (decisions #35).
pub const FLOOR_LEX: f64 = 0.34;
pub const FLOOR_COS: f32 = 0.30;
pub const FLOOR_COS_HARD: f32 = 0.28;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Fused {
    pub chunk_id: String,
    /// RRF score normalized so that rank 1 in every list equals 1.0.
    pub score: f64,
    pub lex_rank: Option<usize>,
    pub vec_rank: Option<usize>,
}

/// Reciprocal rank fusion of the two candidate lists (either may be empty). `weights` scale each
/// list's contribution (equal by default; the adaptive lexical weight doubles the first).
pub fn fuse(lex: &[String], vec: &[String], weights: (f64, f64), k: usize) -> Vec<Fused> {
    let lists: Vec<Vec<String>> = vec![lex.to_vec(), vec.to_vec()];
    let fused = rrf::fuse_weighted(&lists, &[weights.0, weights.1], k);
    let norm = (weights.0 + weights.1) / (k as f64 + 1.0);
    let lex_rank: HashMap<&String, usize> =
        lex.iter().enumerate().map(|(i, c)| (c, i + 1)).collect();
    let vec_rank: HashMap<&String, usize> =
        vec.iter().enumerate().map(|(i, c)| (c, i + 1)).collect();
    fused
        .into_iter()
        .map(|(chunk_id, score)| Fused {
            lex_rank: lex_rank.get(&chunk_id).copied(),
            vec_rank: vec_rank.get(&chunk_id).copied(),
            score: if norm > 0.0 { score / norm } else { score },
            chunk_id,
        })
        .collect()
}

/// An ID/term-like query: at most three content terms, or a defined term covering at least half
/// of them. A long question that merely mentions "employer" is not term-like (decisions #20).
pub fn term_like(query_content_terms: usize, term_words: usize) -> bool {
    term_words > 0 && (query_content_terms <= 3 || 2 * term_words >= query_content_terms)
}

/// Lexical and vector weights for the fusion.
pub fn weights(id_or_term_like: bool, seed: bool) -> (f64, f64) {
    if seed {
        (LEXICAL_WEIGHT_SEED, 1.0)
    } else if id_or_term_like {
        (LEXICAL_WEIGHT_TERM_LIKE, 1.0)
    } else {
        (1.0, 1.0)
    }
}

pub fn hub_boost(refs_in: usize) -> f64 {
    ((1.0 + refs_in as f64).ln() * HUB_SCALE).min(HUB_CAP)
}

/// Per-candidate inputs to the signal table.
#[derive(Debug, Clone, Default)]
pub struct Signals {
    /// Fraction (0..1) of the query's content terms that appear in the title or breadcrumb.
    pub title_path_fraction: f64,
    pub refs_in: usize,
    pub is_note: bool,
    /// The candidate is a superseded Expression admitted by `--include-superseded`.
    pub superseded: bool,
    /// Chunks of the same section among the candidates.
    pub chunks_in_section: usize,
}

/// Apply the additive signals to a normalized RRF score.
pub fn apply_signals(score: f64, s: &Signals) -> f64 {
    let mut out = score;
    out += TITLE_PATH_BOOST * s.title_path_fraction.clamp(0.0, 1.0);
    out += hub_boost(s.refs_in);
    if s.chunks_in_section >= COHERENCE_MIN_CHUNKS {
        out += COHERENCE_BOOST;
    }
    if s.is_note {
        out += NOTE_PENALTY;
    }
    if s.superseded {
        out += SUPERSEDED_PENALTY;
    }
    out
}

/// Collapse chunks to one hit per section: the best-scored chunk of each `key` wins; order kept.
pub fn collapse<F: Fn(&str) -> String>(fused: Vec<Fused>, key: F) -> Vec<Fused> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Fused> = Vec::new();
    for f in fused {
        let k = key(&f.chunk_id);
        match seen.get(&k) {
            Some(&i) => {
                if f.score > out[i].score {
                    out[i] = f;
                }
            }
            None => {
                seen.insert(k, out.len());
                out.push(f);
            }
        }
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.chunk_id.cmp(&b.chunk_id))
    });
    out
}

/// Abstention: `lex_overlap` is the fraction of the query's content terms found in the top hit;
/// `cosine` is the top hit's vector similarity when the vector leg ran.
pub fn should_abstain(lex_overlap: f64, cosine: Option<f32>) -> bool {
    match cosine {
        Some(c) => (lex_overlap < FLOOR_LEX && c < FLOOR_COS) || c < FLOOR_COS_HARD,
        None => lex_overlap < FLOOR_LEX,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_prefers_chunks_in_both_lists_and_normalizes() {
        let lex = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let vec = vec!["b".to_string(), "d".to_string(), "a".to_string()];
        let f = fuse(&lex, &vec, (1.0, 1.0), RRF_K);
        assert_eq!(f[0].chunk_id, "b");
        assert_eq!(f[1].chunk_id, "a");
        assert!((f[0].score - (1.0 / 62.0 + 1.0 / 61.0) / (2.0 / 61.0)).abs() < 1e-9);
        let only_lex = fuse(&lex, &[], (1.0, 1.0), RRF_K);
        assert!((only_lex[0].score - 0.5).abs() < 1e-9);
        let weighted = fuse(&lex, &vec, weights(true, false), RRF_K);
        assert_eq!(
            weighted[0].chunk_id, "a",
            "doubling the lexical weight promotes the lexical rank-1"
        );
    }

    #[test]
    fn signals_follow_the_table() {
        assert!((hub_boost(0)).abs() < 1e-12);
        assert!((hub_boost(12) - (13f64).ln() * 0.02).abs() < 1e-12);
        assert!((hub_boost(1_000_000) - 0.10).abs() < 1e-12, "capped");
        let base = 0.8;
        assert!(
            (apply_signals(
                base,
                &Signals {
                    title_path_fraction: 0.5,
                    ..Default::default()
                }
            ) - 0.85)
                .abs()
                < 1e-12
        );
        assert!(
            (apply_signals(
                base,
                &Signals {
                    is_note: true,
                    ..Default::default()
                }
            ) - 0.6)
                .abs()
                < 1e-12
        );
        assert!(
            (apply_signals(
                base,
                &Signals {
                    superseded: true,
                    ..Default::default()
                }
            ) - 0.3)
                .abs()
                < 1e-12
        );
        assert!(
            (apply_signals(
                base,
                &Signals {
                    chunks_in_section: 3,
                    ..Default::default()
                }
            ) - 0.9)
                .abs()
                < 1e-12
        );
        assert!(
            (apply_signals(
                base,
                &Signals {
                    chunks_in_section: 2,
                    ..Default::default()
                }
            ) - 0.8)
                .abs()
                < 1e-12
        );
    }

    #[test]
    fn term_like_and_abstention_rules() {
        assert!(term_like(3, 1), "short query with a term");
        assert!(term_like(4, 2), "term covers half");
        assert!(!term_like(5, 1), "long question that mentions a term");
        assert!(!term_like(2, 0), "no term at all");
        assert_eq!(weights(false, false), (1.0, 1.0));
        assert_eq!(weights(true, false), (2.0, 1.0));
        assert_eq!(weights(false, true), (3.0, 1.0));
        assert!(should_abstain(0.2, Some(0.29)));
        assert!(
            !should_abstain(0.5, Some(0.29)),
            "lexical overlap rescues a cosine above the hard floor"
        );
        assert!(should_abstain(0.9, Some(0.25)), "hard cosine floor");
        assert!(!should_abstain(0.2, Some(0.6)));
        assert!(should_abstain(0.1, None));
    }

    #[test]
    fn collapse_keeps_the_best_chunk_per_section() {
        let fused = vec![
            Fused {
                chunk_id: "s1#c0".into(),
                score: 0.9,
                lex_rank: Some(1),
                vec_rank: None,
            },
            Fused {
                chunk_id: "s2#c0".into(),
                score: 0.8,
                lex_rank: Some(2),
                vec_rank: None,
            },
            Fused {
                chunk_id: "s1#c1".into(),
                score: 0.7,
                lex_rank: Some(3),
                vec_rank: None,
            },
        ];
        let out = collapse(fused, |c| c.split('#').next().unwrap().to_string());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].chunk_id, "s1#c0");
    }
}
