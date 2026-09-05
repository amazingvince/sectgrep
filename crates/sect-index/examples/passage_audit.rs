//! Recount model inputs and verify every compiled quote against its pinned canonical body.
//! This checks mechanical integrity, not independent relevance or extraction accuracy.
use sect_corpus::Document;
use sect_index::{chunks::SourceSpan, index_dir, open};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: passage_audit CORPUS")?,
    );
    let dir = index_dir(&root);
    let index = open(&root, sect_core::Refresh::No)?;
    let chunks = index.chunks()?;
    let mut bodies = BTreeMap::new();
    for line in std::fs::read_to_string(dir.join("docs.jsonl"))?.lines() {
        let value: serde_json::Value = serde_json::from_str(line)?;
        let doc: Document = serde_json::from_value(value["doc"].clone())?;
        if let Some(expr) = doc.expr() {
            bodies.insert(expr, doc.body_plain());
        }
    }
    let tokenizer = if dir.join("semantic/model/tokenizer.json").exists() {
        Some(sect_semantic::TokenCounter::load(
            dir.join("semantic/model").to_str().ok_or("invalid path")?,
        )?)
    } else if dir.join("semantic/tokenizer.json").exists() {
        Some(sect_semantic::TokenCounter::load(
            dir.join("semantic").to_str().ok_or("invalid path")?,
        )?)
    } else {
        None
    };
    let hashes: BTreeMap<_, _> = bodies
        .iter()
        .map(|(id, body)| (id, format!("{:x}", Sha256::digest(body.as_bytes()))))
        .collect();
    let mut failures = Vec::new();
    let verify = |span: &SourceSpan, quote: &str| -> bool {
        bodies
            .get(&span.expr)
            .and_then(|s| s.get(span.byte_start..span.byte_end))
            == Some(quote)
            && hashes.get(&span.expr) == Some(&span.body_sha256)
    };
    let mut intervals: BTreeMap<String, Vec<(usize, usize)>> = BTreeMap::new();
    let mut navigation = HashSet::new();
    let mut counts = Vec::new();
    let mut words = Vec::new();
    let mut spans = 0;
    let mut supports = 0;
    for c in chunks.iter() {
        let count = if let Some(t) = &tokenizer {
            t.count(&c.text)?
        } else {
            c.text.split_whitespace().count()
        };
        counts.push(count);
        if count != c.token_count || count > index.manifest.passage_policy.max {
            failures.push(format!(
                "input budget/count mismatch: {}: actual {count}, recorded {}",
                c.chunk_id, c.token_count
            ));
        }
        if c.navigation {
            navigation.insert(c.expr.clone());
        } else {
            words.push(c.body.split_whitespace().count());
        }
        for span in &c.spans {
            spans += 1;
            if c.body
                .get(span.passage_start..span.passage_end)
                .is_none_or(|s| !verify(span, s))
            {
                failures.push(format!("source span mismatch: {}", c.chunk_id));
            }
            if !c.navigation {
                intervals
                    .entry(span.expr.clone())
                    .or_default()
                    .push((span.byte_start, span.byte_end));
            }
        }
        for support in &c.support {
            supports += 1;
            if !verify(&support.span, &support.text) {
                failures.push(format!("support span mismatch: {}", c.chunk_id));
            }
        }
    }
    for (expr, body) in &bodies {
        if navigation.contains(expr) {
            continue;
        }
        let ranges = intervals.entry(expr.clone()).or_default();
        ranges.sort();
        let mut end = 0;
        for &(a, b) in ranges.iter() {
            if a < end {
                failures.push(format!("overlapping canonical ranges: {expr}"));
            }
            if body.get(end..a).is_none_or(|s| !s.trim().is_empty()) {
                failures.push(format!("uncovered canonical content: {expr}:{end}..{a}"));
            }
            end = b;
        }
        if body.get(end..).is_none_or(|s| !s.trim().is_empty()) {
            failures.push(format!("uncovered canonical tail: {expr}:{end}"));
        }
    }
    words.sort();
    counts.sort();
    let sources = index.regions()?;
    let mut raw_bytes = 0;
    let mut regions = 0;
    for d in sources.documents.values() {
        let bytes = std::fs::read(dir.join("corpus").join(&d.raw))?;
        raw_bytes += bytes.len();
        regions += d.regions.len();
        if format!("{:x}", Sha256::digest(&bytes)) != d.raw_sha256 {
            failures.push(format!("raw revision mismatch: {}", d.document));
        }
        d.validate().map_err(|e| format!("{}: {e}", d.document))?;
    }
    let result = json!({"generation":index.manifest.generation,"mechanical_integrity_passed":failures.is_empty(),"independent_relevance_judgments":false,
        "raw_documents":sources.documents.len(),"raw_bytes":raw_bytes,"source_regions":regions,"canonical_expressions":bodies.len(),
        "stored_passages":chunks.len(),"content_passages":words.len(),"navigation_entries":navigation.len(),"source_spans_checked":spans,"support_spans_checked":supports,
        "merged_passages":chunks.iter().filter(|c|c.spans.len()>1).count(),"fallback_boundaries":chunks.iter().filter(|c|c.boundary_fallback).count(),
        "model_tokenizer_recounted":tokenizer.is_some(),"max_input_count":counts.last(),"median_content_words":words.get(words.len()/2),
        "content_under_50_words":words.iter().filter(|&&w|w<50).count(),"failures":failures});
    println!("{}", serde_json::to_string_pretty(&result)?);
    if !failures.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}
