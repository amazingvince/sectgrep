//! Fusion (spec B.4 "Fusion / rerank"): BM25 top-100 + vector top-100 -> RRF (k = 60, the `rrf`
//! crate) -> one hit per section. The signal table (citation short-circuit, adaptive lexical
//! weight, title/path match, hub boost, notes penalty, superseded penalty) lands at milestone 5.

use std::collections::HashMap;

use serde::Serialize;

pub const RRF_K: usize = 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Fused {
    pub chunk_id: String,
    /// RRF score normalized so that rank 1 in every list equals 1.0.
    pub score: f64,
    pub lex_rank: Option<usize>,
    pub vec_rank: Option<usize>,
}

/// Reciprocal rank fusion of the two candidate lists (either may be empty). `weights` scale each
/// list's contribution (equal by default; the adaptive lexical weight of milestone 5 uses this).
pub fn fuse(lex: &[String], vec: &[String], weights: (f64, f64), k: usize) -> Vec<Fused> {
    let lists: Vec<Vec<String>> = vec![lex.to_vec(), vec.to_vec()];
    let fused = rrf::fuse_weighted(&lists, &[weights.0, weights.1], k);
    let norm = (weights.0 + weights.1) / (k as f64 + 1.0);
    let lex_rank: HashMap<&String, usize> = lex.iter().enumerate().map(|(i, c)| (c, i + 1)).collect();
    let vec_rank: HashMap<&String, usize> = vec.iter().enumerate().map(|(i, c)| (c, i + 1)).collect();
    fused
        .into_iter()
        .map(|(chunk_id, score)| Fused { lex_rank: lex_rank.get(&chunk_id).copied(), vec_rank: vec_rank.get(&chunk_id).copied(), score: if norm > 0.0 { score / norm } else { score }, chunk_id })
        .collect()
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
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.chunk_id.cmp(&b.chunk_id)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_prefers_chunks_in_both_lists_and_normalizes() {
        let lex = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let vec = vec!["b".to_string(), "d".to_string(), "a".to_string()];
        let f = fuse(&lex, &vec, (1.0, 1.0), RRF_K);
        assert_eq!(f[0].chunk_id, "b"); // ranks 2 and 1
        assert_eq!(f[1].chunk_id, "a"); // ranks 1 and 3
        assert!((f[0].score - (1.0 / 62.0 + 1.0 / 61.0) / (2.0 / 61.0)).abs() < 1e-9);
        assert_eq!(f[0].lex_rank, Some(2));
        assert_eq!(f[0].vec_rank, Some(1));
        let only_lex = fuse(&lex, &[], (1.0, 1.0), RRF_K);
        assert!((only_lex[0].score - 0.5).abs() < 1e-9, "rank 1 in one of two lists is 0.5");
        let weighted = fuse(&lex, &vec, (2.0, 1.0), RRF_K);
        assert_eq!(weighted[0].chunk_id, "a", "doubling the lexical weight promotes the lexical rank-1: {weighted:?}");
    }

    #[test]
    fn collapse_keeps_the_best_chunk_per_section() {
        let fused = vec![
            Fused { chunk_id: "s1#c0".into(), score: 0.9, lex_rank: Some(1), vec_rank: None },
            Fused { chunk_id: "s2#c0".into(), score: 0.8, lex_rank: Some(2), vec_rank: None },
            Fused { chunk_id: "s1#c1".into(), score: 0.7, lex_rank: Some(3), vec_rank: None },
        ];
        let out = collapse(fused, |c| c.split('#').next().unwrap().to_string());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].chunk_id, "s1#c0");
    }
}
