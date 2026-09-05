//! A dependency manifest over the previous generation's passages, not a second text store.
//!
//! Native document members form one invalidation group because peer assembly, headers and
//! notes cross section boundaries. Legacy Markdown sections remain independent. Ancestor
//! projections are hashed separately, so a scope change also invalidates affected children.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

use chrono::NaiveDate;
use rayon::prelude::*;
use sect_core::{Result, SectError};
use sect_corpus::Document;
use sect_struct::Tree;
use serde::{Deserialize, Serialize};

use crate::{
    chunks::{self, Chunk},
    passages::{self, Budget},
    regions::SourceIndex,
};

pub const FILE: &str = "compiled-passages.json";
const VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stats {
    pub compiled_documents: usize,
    pub reused_documents: usize,
    pub compiled_groups: usize,
    pub reused_groups: usize,
    pub reused_passages: usize,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    input: String,
    output: String,
    chunks: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Cache {
    version: u32,
    groups: BTreeMap<String, Entry>,
}

impl Cache {
    pub fn save(&self, dir: &Path) -> Result<()> {
        let path = dir.join(FILE);
        std::fs::write(&path, serde_json::to_vec(self)?).map_err(|e| SectError::io(&path, e))
    }
}

fn hash(value: &impl Serialize) -> Result<String> {
    Ok(blake3::hash(&serde_json::to_vec(value)?)
        .to_hex()
        .to_string())
}

struct Group {
    key: String,
    input: String,
    docs: Vec<usize>,
}

fn root(parents: &mut [usize], mut i: usize) -> usize {
    while parents[i] != i {
        parents[i] = parents[parents[i]];
        i = parents[i];
    }
    i
}

fn groups(
    docs: &[Document],
    tree: &Tree,
    budget: &Budget,
    sources: &SourceIndex,
    today: NaiveDate,
) -> Result<(Vec<Group>, HashMap<String, usize>)> {
    // Canonicalize object keys: tokenizer vocabulary maps need not serialize in a stable order.
    let mut tokenizer: Option<serde_json::Value> = budget
        .tokenizer
        .as_ref()
        .map(|t| -> Result<_> { Ok(serde_json::from_str(&t.configuration()?)?) })
        .transpose()?;
    if let Some(value) = &mut tokenizer {
        value.sort_all_objects();
    }
    let recipe = hash(&(
        VERSION,
        sect_core::SCHEMA_VERSION,
        crate::regions::SOURCE_CODEC,
        passages::RECIPE,
        &budget.policy,
        budget.unit(),
        tokenizer,
    ))?;
    let by_expr: HashMap<String, usize> = docs
        .iter()
        .enumerate()
        .filter_map(|(i, d)| d.expr().map(|e| (e, i)))
        .collect();
    let mut parents: Vec<usize> = (0..docs.len()).collect();
    let mut artifacts = Vec::new();
    for (key, artifact) in &sources.documents {
        let members: Vec<usize> = artifact
            .units
            .iter()
            .filter_map(|u| {
                by_expr
                    .get(&format!("{}@{}", u.id, artifact.effective))
                    .copied()
            })
            .collect();
        if let Some(&first) = members.first() {
            for &member in &members[1..] {
                let a = root(&mut parents, first);
                let b = root(&mut parents, member);
                parents[b.max(a)] = b.min(a);
            }
            artifacts.push((first, key, hash(artifact)?));
        }
    }
    let mut members: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..docs.len() {
        members.entry(root(&mut parents, i)).or_default().push(i);
    }
    let mut native: BTreeMap<usize, Vec<(&str, String)>> = BTreeMap::new();
    for (i, key, digest) in artifacts {
        native
            .entry(root(&mut parents, i))
            .or_default()
            .push((key, digest));
    }
    // Hash parsed input, not only raw file size/mtime: resolver and registry changes can alter it.
    let hashes: Vec<Result<String>> = docs
        .par_iter()
        .map(|d| hash(&(d, chunks::context(d, tree, today))))
        .collect();
    let hashes = hashes.into_iter().collect::<Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(members.len());
    let mut expression_groups = HashMap::new();
    for (owner, indices) in members {
        let key = indices
            .iter()
            .map(|&i| docs[i].rel.as_str())
            .min()
            .unwrap()
            .to_string();
        let inputs: Vec<&str> = indices.iter().map(|&i| hashes[i].as_str()).collect();
        let input = hash(&(&recipe, inputs, native.get(&owner)))?;
        for &i in &indices {
            if let Some(expr) = docs[i].expr() {
                expression_groups.insert(expr, out.len());
            }
        }
        out.push(Group {
            key,
            input,
            docs: indices,
        });
    }
    Ok((out, expression_groups))
}

pub(crate) struct Previous<'a> {
    pub chunks: &'a mut HashMap<String, Chunk>,
    pub dir: &'a Path,
    pub reuse: bool,
}

pub(crate) fn compile(
    docs: &[Document],
    tree: &Tree,
    budget: &Budget,
    sources: &SourceIndex,
    previous: Previous<'_>,
    today: NaiveDate,
) -> Result<(Vec<Chunk>, Cache, Stats, HashSet<String>)> {
    let prior = if previous.reuse {
        std::fs::read(previous.dir.join(FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<Cache>(&b).ok())
            .filter(|c| c.version == VERSION)
    } else {
        None
    };
    let (groups, expression_groups) = groups(docs, tree, budget, sources, today)?;
    let mut stats = Stats::default();
    let mut dirty = vec![false; docs.len()];
    let mut chunks = Vec::new();
    let mut reused_ids = HashSet::new();
    for (group_index, group) in groups.iter().enumerate() {
        let candidate = prior
            .as_ref()
            .and_then(|c| c.groups.get(&group.key))
            .filter(|entry| entry.input == group.input);
        let cached = candidate.and_then(|entry| {
            let mut seen = HashSet::new();
            let stored: Option<Vec<&Chunk>> = entry
                .chunks
                .iter()
                .map(|id| {
                    let chunk = previous.chunks.get(id)?;
                    // A cache record cannot reuse another group's passages or duplicate one.
                    if !seen.insert(id)
                        || expression_groups.get(&chunk.expr) != Some(&group_index)
                        || chunk
                            .spans
                            .iter()
                            .any(|s| expression_groups.get(&s.expr) != Some(&group_index))
                        || chunk
                            .support
                            .iter()
                            .any(|s| expression_groups.get(&s.span.expr) != Some(&group_index))
                    {
                        return None;
                    }
                    Some(chunk)
                })
                .collect();
            stored
                .filter(|stored| hash(stored).ok().as_deref() == Some(&entry.output))
                .map(|_| &entry.chunks)
        });
        if let Some(cached) = cached {
            stats.reused_groups += 1;
            stats.reused_documents += group.docs.len();
            stats.reused_passages += cached.len();
            for id in cached {
                // Ownership moves after checksum/membership validation; retaining a cloned
                // previous inventory would double the resident passage text on cache hits.
                reused_ids.insert(id.clone());
                chunks.push(
                    previous
                        .chunks
                        .remove(id)
                        .expect("validated cached passage"),
                );
            }
        } else {
            stats.compiled_groups += 1;
            stats.compiled_documents += group.docs.len();
            for &i in &group.docs {
                dirty[i] = true;
            }
        }
    }
    let selected: Vec<&Document> = docs
        .iter()
        .enumerate()
        .filter(|(i, _)| dirty[*i])
        .map(|(_, d)| d)
        .collect();
    if !selected.is_empty() {
        let mut compiled = chunks::merge_peers(
            chunks::build_selected(&selected, tree, budget, sources, today)?,
            sources,
            budget,
        )?;
        chunks::attach_support(&mut compiled, docs, sources);
        chunks::bind_addresses(&mut compiled)?;
        chunks.extend(compiled);
    }
    chunks.sort_by(|a, b| a.expr.cmp(&b.expr).then(a.part.cmp(&b.part)));
    let mut by_group = vec![Vec::new(); groups.len()];
    for chunk in &chunks {
        let group = expression_groups
            .get(&chunk.expr)
            .ok_or_else(|| SectError::Other("compiled passage has no source group".into()))?;
        by_group[*group].push(chunk);
    }
    let mut entries = BTreeMap::new();
    for (group, passages) in groups.into_iter().zip(by_group) {
        entries.insert(
            group.key,
            Entry {
                input: group.input,
                output: hash(&passages)?,
                chunks: passages.into_iter().map(|c| c.chunk_id.clone()).collect(),
            },
        );
    }
    Ok((
        chunks,
        Cache {
            version: VERSION,
            groups: entries,
        },
        stats,
        reused_ids,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn doc(id: &str, effective: &str, parent: Option<&str>, title: &str) -> Document {
        Document {
            rel: format!("test/{id}-{effective}.md"),
            source: "test".into(),
            front: sect_core::FrontMatter {
                id: Some(format!("T:{id}")),
                effective: Some(date(effective)),
                parent: parent.map(|id| format!("T:{id}")),
                title: Some(title.into()),
                ..Default::default()
            },
            body: format!("# {title}\n\nA complete piece of evidence."),
            keys: Default::default(),
            provenance_keys: Default::default(),
            paragraph_anchors: vec![],
            links: vec![],
            tables: vec![],
            definitions: vec![],
            word_count: 7,
        }
    }

    fn run(
        docs: &[Document],
        budget: &Budget,
        today: NaiveDate,
        dir: &Path,
        previous: &mut HashMap<String, Chunk>,
    ) -> (Vec<Chunk>, Stats) {
        let tree = sect_struct::build_tree(docs, &BTreeMap::new());
        let (chunks, cache, stats, _) = compile(
            docs,
            &tree,
            budget,
            &SourceIndex::default(),
            Previous {
                chunks: previous,
                dir,
                reuse: true,
            },
            today,
        )
        .unwrap();
        cache.save(dir).unwrap();
        (chunks, stats)
    }

    #[test]
    fn date_projection_invalidates_only_changed_scope() {
        let cache = tempfile::tempdir().unwrap();
        let mut old = doc("root", "2024-01-01", None, "Old manual");
        old.front.superseded_by = Some("T:root@2030-01-01".into());
        let docs = vec![
            old,
            doc("root", "2030-01-01", None, "Future manual"),
            doc("child", "2024-01-01", Some("root"), "Rule"),
            doc("other", "2024-01-01", None, "Other document"),
        ];
        let budget = Budget {
            policy: Default::default(),
            tokenizer: None,
        };
        let (before, _) = run(
            &docs,
            &budget,
            date("2025-01-01"),
            cache.path(),
            &mut HashMap::new(),
        );
        assert!(before
            .iter()
            .find(|c| c.id == "T:child")
            .unwrap()
            .breadcrumb
            .contains("Old manual"));
        let mut previous = before
            .into_iter()
            .map(|c| (c.chunk_id.clone(), c))
            .collect();
        let (after, stats) = run(
            &docs,
            &budget,
            date("2031-01-01"),
            cache.path(),
            &mut previous,
        );
        assert_eq!(stats.compiled_documents, 1);
        assert_eq!(stats.reused_documents, 3);
        assert!(after
            .iter()
            .find(|c| c.id == "T:child")
            .unwrap()
            .breadcrumb
            .contains("Future manual"));
        let (full, _) = run(
            &docs,
            &budget,
            date("2031-01-01"),
            cache.path(),
            &mut HashMap::new(),
        );
        assert_eq!(after, full);
    }

    #[test]
    fn tokenizer_content_binds_cache_independently_of_path_or_map_order() {
        let cache = tempfile::tempdir().unwrap();
        let model = tempfile::tempdir().unwrap();
        let docs = vec![doc("a", "2024-01-01", None, "Title")];
        let tokenizer = |normalizer: &str, vocab: &str| {
            std::fs::write(
                model.path().join("tokenizer.json"),
                format!(
                    r#"{{
                "version":"1.0","truncation":null,"padding":null,"added_tokens":[],
                "normalizer":{normalizer},"pre_tokenizer":{{"type":"WhitespaceSplit"}},
                "post_processor":null,"decoder":null,
                "model":{{"type":"WordLevel","vocab":{vocab},"unk_token":"[UNK]"}}
            }}"#
                ),
            )
            .unwrap();
            sect_semantic::TokenCounter::load(model.path().to_str().unwrap()).unwrap()
        };
        let mut budget = Budget {
            policy: Default::default(),
            tokenizer: Some(tokenizer("null", r#"{"[UNK]":0,"Title":1}"#)),
        };
        let (before, _) = run(
            &docs,
            &budget,
            date("2025-01-01"),
            cache.path(),
            &mut HashMap::new(),
        );
        let mut previous = before
            .into_iter()
            .map(|c| (c.chunk_id.clone(), c))
            .collect();
        budget.tokenizer = Some(tokenizer("null", r#"{"Title":1,"[UNK]":0}"#));
        let (same_chunks, same) = run(
            &docs,
            &budget,
            date("2025-01-01"),
            cache.path(),
            &mut previous,
        );
        assert_eq!(same.reused_documents, 1);
        previous = same_chunks
            .into_iter()
            .map(|c| (c.chunk_id.clone(), c))
            .collect();
        budget.tokenizer = Some(tokenizer(
            r#"{"type":"Lowercase"}"#,
            r#"{"Title":1,"[UNK]":0}"#,
        ));
        let (changed, stats) = run(
            &docs,
            &budget,
            date("2025-01-01"),
            cache.path(),
            &mut previous,
        );
        assert_eq!(stats.compiled_documents, 1);
        let (full, _) = run(
            &docs,
            &budget,
            date("2025-01-01"),
            cache.path(),
            &mut HashMap::new(),
        );
        assert_eq!(changed, full);
    }
}
