//! Index build and freshness (spec B.6). Walk, blake3 fingerprint diff, validate (errors block),
//! parse, rebuild the structural files, write `manifest.json` and append `log.jsonl`. Every query
//! stats the tree first and either answers `fresh`, rebuilds, or answers `possibly_stale`.
//!
//! Milestones 1-2 rebuild the structural layer whole when anything changed; milestone 6 makes
//! the rebuild incremental and moves large rebuilds to the background.

pub mod chunks;

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};
use sect_core::{Freshness, Result, SectError, SourceConfig, INDEX_DIR, SCHEMA_VERSION, VERSION};
use sect_corpus::{
    fingerprint_file, load_sources, parse_document, split_front_matter, stat_file, validate, walk_corpus, Document,
    Fingerprint, Issue, Level, Resolver,
};
use sect_lexical::LexDoc;
use sect_semantic::{EmbeddingProvider, Model2VecProvider, VectorIndex};
use sect_struct::{build_graph, build_tree, Edge, Graph, Tree};
use serde::{Deserialize, Serialize};

pub use chunks::Chunk;

pub const MANIFEST: &str = "manifest.json";
pub const FINGERPRINTS: &str = "fingerprints.json";
pub const TREE: &str = "tree.json";
pub const LOG: &str = "log.jsonl";
pub const CHUNKS: &str = "chunks.jsonl";
pub const VECTORS: &str = "vectors.bin";
pub const TANTIVY_DIR: &str = "tantivy";
pub const MODEL_DIR: &str = "semantic/model";
pub const STRUCTURAL_FILES: &[&str] = &["tree.json", "xrefs.jsonl", "actions.jsonl", "terms.json", "tables.jsonl", "chunks.jsonl"];

#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    /// Ignore stored fingerprints and re-hash everything.
    pub full: bool,
    /// Run the contract check only; write nothing (the check WS3 runs on staging).
    pub validate_only: bool,
    /// Embedding provider spec (`model2vec:<repo-or-path>`, a bare repo/path, or `none` to skip
    /// the semantic layer). None = the default potion-retrieval-32M.
    pub embedding: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildReport {
    pub files: usize,
    pub works: usize,
    pub expressions: usize,
    pub superseded: usize,
    pub sources: usize,
    /// Files added, removed, or with changed content since the previous build.
    pub changed: usize,
    pub edges: usize,
    pub actions: usize,
    pub terms: usize,
    pub tables: usize,
    pub unresolved_refs: usize,
    pub issues: Vec<Issue>,
    pub elapsed_ms: u128,
    pub validate_only: bool,
    /// False when errors blocked the write or validate-only was requested.
    pub written: bool,
}

impl BuildReport {
    pub fn errors(&self) -> usize {
        self.issues.iter().filter(|i| i.level == Level::Error).count()
    }
    pub fn warnings(&self) -> usize {
        self.issues.iter().filter(|i| i.level == Level::Warning).count()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceSummary {
    pub name: String,
    pub kind: String,
    pub precedence: i64,
    pub legal_status: String,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub sect_version: String,
    pub built_at: String,
    pub corpus_root: String,
    pub files: usize,
    pub works: usize,
    pub expressions: usize,
    pub superseded: usize,
    pub sources: Vec<SourceSummary>,
    /// Which index layers exist on disk: structural, lexical, semantic now; exact and ngram at 3b.
    pub layers: BTreeMap<String, bool>,
    #[serde(default)]
    pub chunks: usize,
    /// Embedding provider recorded at build time (e.g. `model2vec:minishlab/potion-retrieval-32M`).
    #[serde(default)]
    pub embedding: Option<String>,
    #[serde(default)]
    pub edges: usize,
    #[serde(default)]
    pub actions: usize,
    #[serde(default)]
    pub terms: usize,
    #[serde(default)]
    pub tables: usize,
    pub warnings: Vec<Issue>,
    /// Cross-references whose target does not resolve (spec B.4: reported by `status`).
    #[serde(default)]
    pub unresolved: Vec<Edge>,
    pub unresolved_refs: usize,
    pub build_ms: u128,
}

pub fn index_dir(root: &Path) -> PathBuf {
    root.join(INDEX_DIR)
}

/// Make a corpus path absolute without `canonicalize` (which adds `\\?\` on Windows).
pub fn absolutize(root: &Path) -> PathBuf {
    if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir().map(|c| c.join(root)).unwrap_or_else(|_| root.to_path_buf())
    }
}

fn load_fingerprints(dir: &Path) -> BTreeMap<String, Fingerprint> {
    std::fs::read_to_string(dir.join(FINGERPRINTS)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn load_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join(MANIFEST);
    let text = std::fs::read_to_string(&path).map_err(|e| SectError::io(&path, e))?;
    Ok(serde_json::from_str(&text)?)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn append_log(dir: &Path, entry: &serde_json::Value) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(LOG)) {
        let _ = writeln!(f, "{entry}");
    }
}

/// Exclusive build lock: `.sect/.lock`, created atomically; a second builder waits for it and a
/// lock older than ten minutes is treated as abandoned. Two `sect` processes rebuilding the same
/// index at once would otherwise race on the tantivy directory.
struct BuildLock(PathBuf);

impl BuildLock {
    fn acquire(dir: &Path) -> Result<BuildLock> {
        std::fs::create_dir_all(dir).map_err(|e| SectError::io(dir, e))?;
        let path = dir.join(".lock");
        let started = Instant::now();
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    let _ = writeln!(f, "{} {}", std::process::id(), now());
                    return Ok(BuildLock(path));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path).and_then(|m| m.modified()).map(|t| t.elapsed().map(|d| d.as_secs() > 600).unwrap_or(false)).unwrap_or(true);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed().as_secs() > 600 {
                        return Err(SectError::Other(format!("index build lock {} held for over ten minutes", path.display())));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(SectError::io(&path, e)),
            }
        }
    }
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Build (or validate) the index for `root`.
pub fn build(root: &Path, opts: &BuildOptions) -> Result<BuildReport> {
    let root = absolutize(root);
    let dir = index_dir(&root);
    let _lock = if opts.validate_only { None } else { Some(BuildLock::acquire(&dir)?) };
    let t0 = Instant::now();
    let sources = load_sources(&root)?;
    let resolver = Resolver::new(&sources);
    let files = walk_corpus(&root, &sources)?;

    let prev = if opts.full { BTreeMap::new() } else { load_fingerprints(&dir) };
    let mut fps: BTreeMap<String, Fingerprint> = BTreeMap::new();
    let mut changed = 0usize;
    for f in &files {
        let (size, mtime) = stat_file(&f.abs)?;
        let fp = match prev.get(&f.rel) {
            Some(p) if p.stat_matches(size, mtime) => p.clone(),
            Some(p) => {
                let fp = fingerprint_file(&f.abs)?;
                if fp.blake3 != p.blake3 {
                    changed += 1;
                }
                fp
            }
            None => {
                changed += 1;
                fingerprint_file(&f.abs)?
            }
        };
        fps.insert(f.rel.clone(), fp);
    }
    changed += prev.keys().filter(|k| !fps.contains_key(*k)).count();

    let timing = std::env::var("SECT_TIMING").is_ok();
    let mut stage = Instant::now();
    let lap = |name: &str, stage: &mut Instant| {
        if timing {
            eprintln!("timing: {name} {} ms", stage.elapsed().as_millis());
            *stage = Instant::now();
        }
    };
    lap("walk+fingerprint", &mut stage);
    let mut issues: Vec<Issue> = Vec::new();
    let mut docs: Vec<Document> = Vec::new();
    for f in &files {
        match parse_document(f, &resolver) {
            Ok(d) => docs.push(d),
            Err(e) => issues.push(Issue { level: Level::Error, path: f.rel.clone(), message: e.to_string() }),
        }
    }
    lap("parse", &mut stage);
    issues.extend(validate(&docs, &sources));
    lap("validate", &mut stage);
    let tree = build_tree(&docs, &sources);
    lap("tree", &mut stage);
    let graph = build_graph(&docs, &tree);
    lap("graph", &mut stage);
    let (works, expressions, superseded) = tree.counts();
    let unresolved: Vec<Edge> = graph.unresolved().into_iter().cloned().collect();
    let mut report = BuildReport {
        files: files.len(),
        works,
        expressions,
        superseded,
        sources: sources.len(),
        changed,
        edges: graph.edges.len(),
        actions: graph.actions.len(),
        terms: graph.terms.len(),
        tables: graph.tables.len(),
        unresolved_refs: unresolved.len(),
        issues,
        elapsed_ms: 0,
        validate_only: opts.validate_only,
        written: false,
    };
    let errors = report.errors();
    if opts.validate_only || errors > 0 {
        report.elapsed_ms = t0.elapsed().as_millis();
        if dir.is_dir() {
            append_log(&dir, &serde_json::json!({"ts": now(), "action": if opts.validate_only {"validate"} else {"build-blocked"}, "files": report.files, "changed": changed, "errors": errors, "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms}));
        }
        return Ok(report);
    }

    std::fs::create_dir_all(&dir).map_err(|e| SectError::io(&dir, e))?;
    tree.save(&dir.join(TREE))?;
    graph.save(&dir)?;
    let chunk_list = chunks::build_chunks(&docs, &tree);
    chunks::save(&dir.join(CHUNKS), &chunk_list)?;
    let lex_docs: Vec<LexDoc> = chunk_list
        .iter()
        .map(|c| LexDoc {
            chunk_id: c.chunk_id.clone(),
            expr: c.expr.clone(),
            id: c.id.clone(),
            node: c.node.clone(),
            title: format!("{} {}", c.label, c.title),
            path: c.breadcrumb.clone(),
            context: c.context.clone(),
            body: c.body.clone(),
            citations: c.citations.clone(),
            terms_defined: c.terms_defined.clone(),
            source: c.source.clone(),
            kind: c.kind.clone(),
            effective: c.effective,
            superseded: c.superseded,
        })
        .collect();
    lap("chunks", &mut stage);
    sect_lexical::build(&dir.join(TANTIVY_DIR), &lex_docs)?;
    lap("lexical", &mut stage);
    let embedding_spec = opts.embedding.clone().unwrap_or_else(|| sect_semantic::DEFAULT_MODEL.to_string());
    let mut embedding_name = None;
    let semantic_built = if embedding_spec == "none" {
        let _ = std::fs::remove_file(dir.join(VECTORS));
        false
    } else {
        // Network (hub fetch) happens here, at index time, never at query time. `provider_for`
        // refuses `remote:` specs unless a remote provider has been configured (opt-in).
        let provider = sect_semantic::provider_for(&embedding_spec)?;
        let target = embedding_spec.strip_prefix("model2vec:").unwrap_or(&embedding_spec).to_string();
        let model_dir = dir.join(MODEL_DIR);
        Model2VecProvider::materialize(&target, &model_dir)?;
        let texts: Vec<String> = chunk_list.iter().map(|c| c.text.clone()).collect();
        let ids: Vec<String> = chunk_list.iter().map(|c| c.chunk_id.clone()).collect();
        let vectors = VectorIndex::build(provider.as_ref(), ids, &texts)?;
        vectors.save(&dir.join(VECTORS))?;
        embedding_name = Some(provider.name());
        lap("semantic", &mut stage);
        true
    };
    let fp_path = dir.join(FINGERPRINTS);
    std::fs::write(&fp_path, serde_json::to_string_pretty(&fps)?).map_err(|e| SectError::io(&fp_path, e))?;
    let mut per_source: BTreeMap<String, usize> = BTreeMap::new();
    for f in &files {
        *per_source.entry(f.source.clone()).or_default() += 1;
    }
    report.elapsed_ms = t0.elapsed().as_millis();
    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        sect_version: VERSION.to_string(),
        built_at: now(),
        corpus_root: root.to_string_lossy().replace('\\', "/"),
        files: files.len(),
        works,
        expressions,
        superseded,
        sources: sources
            .values()
            .map(|s: &SourceConfig| SourceSummary {
                name: s.name.clone(),
                kind: s.kind.clone(),
                precedence: s.precedence,
                legal_status: s.legal_status.clone(),
                files: per_source.get(&s.name).copied().unwrap_or(0),
            })
            .collect(),
        layers: [("structural", true), ("exact", true), ("ngram", false), ("lexical", true), ("semantic", semantic_built)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        chunks: chunk_list.len(),
        embedding: embedding_name,
        edges: graph.edges.len(),
        actions: graph.actions.len(),
        terms: graph.terms.len(),
        tables: graph.tables.len(),
        warnings: report.issues.iter().filter(|i| i.level == Level::Warning).cloned().collect(),
        unresolved_refs: unresolved.len(),
        unresolved,
        build_ms: report.elapsed_ms,
    };
    let m_path = dir.join(MANIFEST);
    std::fs::write(&m_path, serde_json::to_string_pretty(&manifest)?).map_err(|e| SectError::io(&m_path, e))?;
    append_log(&dir, &serde_json::json!({"ts": manifest.built_at, "action": "build", "files": report.files, "changed": changed, "errors": 0, "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms, "full": opts.full}));
    report.written = true;
    Ok(report)
}

/// Result of the pre-query stat pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Check {
    Missing,
    Fresh { files: usize },
    Stale { files: usize, changed: usize },
}

/// Stat every corpus file against `fingerprints.json`; hash only the ones whose stat moved.
pub fn check(root: &Path) -> Result<(Check, Option<Manifest>)> {
    let root = absolutize(root);
    let dir = index_dir(&root);
    let manifest = match load_manifest(&dir) {
        Ok(m) => m,
        Err(_) => return Ok((Check::Missing, None)),
    };
    if STRUCTURAL_FILES.iter().any(|f| !dir.join(f).is_file()) {
        return Ok((Check::Missing, None));
    }
    let sources = load_sources(&root)?;
    let files = walk_corpus(&root, &sources)?;
    let fps = load_fingerprints(&dir);
    let mut changed = 0usize;
    for f in &files {
        match fps.get(&f.rel) {
            None => changed += 1,
            Some(fp) => {
                let (size, mtime) = stat_file(&f.abs)?;
                if !fp.stat_matches(size, mtime) && fingerprint_file(&f.abs)?.blake3 != fp.blake3 {
                    changed += 1;
                }
            }
        }
    }
    changed += fps.keys().filter(|k| !files.iter().any(|f| &f.rel == *k)).count();
    let files = files.len();
    Ok((if changed == 0 { Check::Fresh { files } } else { Check::Stale { files, changed } }, Some(manifest)))
}

/// An opened index: manifest, tree, graph, and the freshness the caller must report first.
pub struct Index {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub tree: Tree,
    pub graph: Graph,
    pub freshness: Freshness,
    pub sources: BTreeMap<String, SourceConfig>,
}

impl Index {
    /// Body text of a section file (front matter stripped), read from disk at query time.
    pub fn read_body(&self, rel: &str) -> Result<String> {
        let path = self.root.join(rel);
        let text = std::fs::read_to_string(&path).map_err(|e| SectError::io(&path, e))?;
        Ok(split_front_matter(&text).map(|(_, b)| b.trim_end().to_string()).unwrap_or(text))
    }

    pub fn dir(&self) -> PathBuf {
        index_dir(&self.root)
    }

    /// The chunk list (loaded on demand; only `search` needs it).
    pub fn chunks(&self) -> Result<Vec<Chunk>> {
        chunks::load(&self.dir().join(CHUNKS))
    }

    pub fn lexical(&self) -> Result<sect_lexical::LexicalIndex> {
        sect_lexical::LexicalIndex::open(&self.dir().join(TANTIVY_DIR))
    }

    pub fn has_semantic(&self) -> bool {
        self.manifest.layers.get("semantic").copied().unwrap_or(false) && self.dir().join(VECTORS).is_file()
    }

    pub fn vectors(&self) -> Result<VectorIndex> {
        VectorIndex::load(&self.dir().join(VECTORS))
    }

    /// The embedding provider for queries: the model copied next to the index, so no network.
    pub fn embedder(&self) -> Result<Box<dyn EmbeddingProvider>> {
        let dir = self.dir().join(MODEL_DIR);
        if !dir.join("model.safetensors").is_file() {
            return Err(SectError::Other(format!("no local embedding model under {}; run `sect index` to build the semantic layer", dir.display())));
        }
        Ok(Box::new(Model2VecProvider::load(&dir.to_string_lossy())?))
    }
}

/// Open the index for `root`, building it when missing and refreshing it when stale (unless
/// `refresh` is false, in which case the answer is marked `possibly_stale`).
pub fn open(root: &Path, refresh: bool) -> Result<Index> {
    let root = absolutize(root);
    let dir = index_dir(&root);
    let (chk, manifest) = check(&root)?;
    let (manifest, freshness) = match (chk, manifest) {
        (Check::Missing, _) => {
            let rep = build(&root, &BuildOptions::default())?;
            if rep.errors() > 0 {
                return Err(SectError::Validation(rep.errors()));
            }
            let m = load_manifest(&dir)?;
            let f = Freshness::Fresh { files: m.files, built_at: m.built_at.clone(), rebuilt: Some(rep.changed) };
            (m, f)
        }
        (Check::Stale { changed, .. }, _) if refresh => {
            let rep = build(&root, &BuildOptions::default())?;
            if rep.errors() > 0 {
                return Err(SectError::Validation(rep.errors()));
            }
            let m = load_manifest(&dir)?;
            let f = Freshness::Fresh { files: m.files, built_at: m.built_at.clone(), rebuilt: Some(changed) };
            (m, f)
        }
        (Check::Stale { files, changed }, Some(m)) => {
            let f = Freshness::PossiblyStale { files, changed, built_at: m.built_at.clone() };
            (m, f)
        }
        (Check::Fresh { files }, Some(m)) => {
            let f = Freshness::Fresh { files, built_at: m.built_at.clone(), rebuilt: None };
            (m, f)
        }
        (_, None) => unreachable!("check returns a manifest unless the index is missing"),
    };
    let tree = Tree::load(&dir.join(TREE))?;
    let graph = Graph::load(&dir)?;
    let sources = load_sources(&root)?;
    Ok(Index { root, manifest, tree, graph, freshness, sources })
}
