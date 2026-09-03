//! Index build and freshness (spec B.6).
//!
//! `sect index`: walk, blake3 fingerprint diff, validate (errors block), parse only what changed
//! (a cache of parsed documents sits next to the fingerprints), rebuild the structural files,
//! update the tantivy and vector layers in place for the changed Expressions, write
//! `manifest.json`, append `log.jsonl`. Re-running on unchanged input does no work.
//!
//! Every query stats the tree first (parallel stat of the tracked files plus the directory
//! mtimes that reveal additions and removals), then answers `fresh`, refreshes a small change
//! set synchronously, or answers `possibly_stale` and rebuilds in a background process.

pub mod chunks;

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};
use rayon::prelude::*;
use sect_core::{Freshness, Refresh, Result, SectError, SourceConfig, INDEX_DIR, SCHEMA_VERSION, VERSION};
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
pub const DOCS_CACHE: &str = "docs.jsonl";
pub const TREE: &str = "tree.json";
pub const LOG: &str = "log.jsonl";
pub const CHUNKS: &str = "chunks.jsonl";
pub const VECTORS: &str = "vectors.bin";
pub const TANTIVY_DIR: &str = "tantivy";
pub const MODEL_DIR: &str = "semantic/model";
pub const STRUCTURAL_FILES: &[&str] = &["tree.json", "xrefs.jsonl", "actions.jsonl", "terms.json", "tables.jsonl", "chunks.jsonl"];
/// Change sets up to this many files are refreshed synchronously by a query; larger ones go to a
/// background rebuild. `SECT_SYNC_LIMIT` overrides it.
pub const SYNC_LIMIT_DEFAULT: usize = 20;

#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    /// Ignore stored fingerprints and caches and rebuild every layer.
    pub full: bool,
    /// Run the contract check only; write nothing (the check WS3 runs on staging).
    pub validate_only: bool,
    /// Embedding provider spec (`model2vec:<repo-or-path>`, a bare repo/path, or `none` to skip
    /// the semantic layer). None = the default potion-retrieval-32M.
    pub embedding: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildReport {
    /// full | incremental | noop | validate | blocked
    pub mode: String,
    pub files: usize,
    pub works: usize,
    pub expressions: usize,
    pub superseded: usize,
    pub sources: usize,
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    pub edges: usize,
    pub actions: usize,
    pub terms: usize,
    pub tables: usize,
    pub chunks: usize,
    pub unresolved_refs: usize,
    pub issues: Vec<Issue>,
    pub elapsed_ms: u128,
    /// Milliseconds per stage: walk, parse, validate, structural, lexical, semantic, write.
    pub layer_ms: BTreeMap<String, u64>,
    pub validate_only: bool,
    /// False when errors blocked the write, validate-only was requested, or nothing had changed.
    pub written: bool,
}

impl BuildReport {
    pub fn errors(&self) -> usize {
        self.issues.iter().filter(|i| i.level == Level::Error).count()
    }
    pub fn warnings(&self) -> usize {
        self.issues.iter().filter(|i| i.level == Level::Warning).count()
    }
    pub fn changed_total(&self) -> usize {
        self.added + self.changed + self.removed
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
    /// Which index layers exist on disk: structural, exact, lexical, semantic now; ngram at 3b.
    pub layers: BTreeMap<String, bool>,
    #[serde(default)]
    pub chunks: usize,
    #[serde(default)]
    pub embedding: Option<String>,
    /// The `--embedding` setting this index was built with (`none` or a provider spec); a rebuild
    /// without the flag inherits it, so a background rebuild never switches models.
    #[serde(default)]
    pub embedding_spec: Option<String>,
    #[serde(default)]
    pub edges: usize,
    #[serde(default)]
    pub actions: usize,
    #[serde(default)]
    pub terms: usize,
    #[serde(default)]
    pub tables: usize,
    pub warnings: Vec<Issue>,
    #[serde(default)]
    pub unresolved: Vec<Edge>,
    pub unresolved_refs: usize,
    pub build_ms: u128,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub layer_ms: BTreeMap<String, u64>,
}

/// `fingerprints.json`: per-file size, mtime, blake3; per-directory mtime (a changed directory
/// mtime is how additions and removals are noticed without a full walk). Stored as compact
/// arrays (still human-readable) because the pre-query stat pass parses it every time.
#[derive(Debug, Clone, Default)]
struct Store {
    files: BTreeMap<String, Fingerprint>,
    dirs: BTreeMap<String, u64>,
}

/// On-disk form. Borrows from the file bytes so the query-time check parses 10k entries
/// without allocating a string per field.
#[derive(Serialize, Deserialize)]
struct StoreFile<'a> {
    #[serde(borrow)]
    columns: Vec<Cow<'a, str>>,
    #[serde(borrow)]
    files: Vec<(Cow<'a, str>, u64, u64, Cow<'a, str>)>,
    #[serde(borrow)]
    dirs: Vec<(Cow<'a, str>, u64)>,
}

impl Store {
    fn to_file(&self) -> StoreFile<'_> {
        StoreFile {
            columns: ["rel", "size", "mtime_ns", "blake3"].iter().map(|c| Cow::Borrowed(*c)).collect(),
            files: self.files.iter().map(|(k, f)| (Cow::Borrowed(k.as_str()), f.size, f.mtime_ns, Cow::Borrowed(f.blake3.as_str()))).collect(),
            dirs: self.dirs.iter().map(|(k, m)| (Cow::Borrowed(k.as_str()), *m)).collect(),
        }
    }
    fn from_file(f: StoreFile<'_>) -> Store {
        Store {
            files: f.files.into_iter().map(|(k, size, mtime_ns, blake3)| (k.into_owned(), Fingerprint { size, mtime_ns, blake3: blake3.into_owned() })).collect(),
            dirs: f.dirs.into_iter().map(|(k, m)| (k.into_owned(), m)).collect(),
        }
    }
    /// Layout is fixed: one JSON array per line inside `files` and `dirs`, which `parse_store_fast`
    /// relies on; the whole file stays valid JSON for everyone else.
    fn save(&self, dir: &Path) -> Result<()> {
        let path = dir.join(FINGERPRINTS);
        let tmp = dir.join("fingerprints.json.tmp");
        let f = self.to_file();
        let mut out = String::with_capacity(160 * (f.files.len() + f.dirs.len()) + 128);
        out.push_str("{\"columns\":");
        out.push_str(&serde_json::to_string(&f.columns)?);
        out.push_str(",\n\"files\":[\n");
        for (i, row) in f.files.iter().enumerate() {
            out.push_str(&serde_json::to_string(row)?);
            out.push_str(if i + 1 < f.files.len() { ",\n" } else { "\n" });
        }
        out.push_str("],\n\"dirs\":[\n");
        for (i, row) in f.dirs.iter().enumerate() {
            out.push_str(&serde_json::to_string(row)?);
            out.push_str(if i + 1 < f.dirs.len() { ",\n" } else { "\n" });
        }
        out.push_str("]}\n");
        std::fs::write(&tmp, out).map_err(|e| SectError::io(&tmp, e))?;
        std::fs::rename(&tmp, &path).map_err(|e| SectError::io(&path, e))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedDoc {
    rel: String,
    blake3: String,
    doc: Document,
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

/// Split the store written by `Store::save` into its file and directory lines without parsing
/// them; the stat pass parses each line on the thread that stats it. None when the layout is not
/// the expected one (a hand-edited or older file), in which case the caller rebuilds.
fn store_lines(bytes: &[u8]) -> Option<(Vec<&str>, Vec<&str>)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let fs = text.find("\n\"files\":[\n")? + "\n\"files\":[\n".len();
    let fe = fs + text[fs..].find("\n],\n\"dirs\":[\n")?;
    let ds = fe + "\n],\n\"dirs\":[\n".len();
    let de = ds + text[ds..].find("\n]}")?;
    let files: Vec<&str> = if fe > fs { text[fs..fe].split('\n').collect() } else { Vec::new() };
    let dirs: Vec<&str> = if de > ds { text[ds..de].split('\n').collect() } else { Vec::new() };
    Some((files, dirs))
}

/// The stat pass runs on a pool of up to 16 threads: measured at 10k files, 16 threads stat in
/// 3.7 ms on ext4 (8: 5.2 ms, 32: 3.4 to 5.8 ms with the extra spawn cost) and in 75 ms on NTFS
/// (8: 104 ms, 32: 68 ms). `SECT_STAT_THREADS` overrides it.
fn stat_pool() -> rayon::ThreadPool {
    let n = std::env::var("SECT_STAT_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map(|p| p.get()).unwrap_or(4).clamp(2, 16));
    rayon::ThreadPoolBuilder::new().num_threads(n).build().expect("stat thread pool")
}

fn load_store(dir: &Path) -> Store {
    let bytes = std::fs::read(dir.join(FINGERPRINTS)).unwrap_or_default();
    serde_json::from_slice::<StoreFile>(&bytes).ok().map(Store::from_file).unwrap_or_default()
}

fn load_docs_cache(dir: &Path) -> HashMap<String, CachedDoc> {
    let Ok(text) = std::fs::read_to_string(dir.join(DOCS_CACHE)) else { return HashMap::new() };
    text.lines().filter_map(|l| serde_json::from_str::<CachedDoc>(l).ok()).map(|c| (c.rel.clone(), c)).collect()
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

fn artifacts_present(dir: &Path, semantic: bool) -> bool {
    dir.join(MANIFEST).is_file()
        && STRUCTURAL_FILES.iter().all(|f| dir.join(f).is_file())
        && dir.join(TANTIVY_DIR).join("meta.json").is_file()
        && (!semantic || dir.join(VECTORS).is_file())
}

/// Exclusive build lock: `.sect/.lock`, created atomically; a second builder waits for it and a
/// lock older than ten minutes is treated as abandoned.
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

pub fn lock_held(root: &Path) -> bool {
    index_dir(&absolutize(root)).join(".lock").is_file()
}

/// Directory snapshot for the stat pass: the root plus every directory that holds corpus
/// files, every source directory, and their ancestors, each stat'd directly. (NTFS updates the
/// timestamps a parent listing reports lazily, so listings are not trusted on any platform.)
fn snapshot_dirs(root: &Path, files: &[sect_corpus::CorpusFile], sources: &BTreeMap<String, SourceConfig>) -> BTreeMap<String, u64> {
    let mut tracked: HashSet<String> = HashSet::new();
    tracked.insert(".".into());
    for s in sources.values() {
        tracked.insert(s.dir.trim_end_matches('/').to_string());
    }
    for f in files {
        let mut p = Path::new(&f.rel).parent();
        while let Some(d) = p {
            let s = d.to_string_lossy().replace('\\', "/");
            if s.is_empty() || !tracked.insert(s) {
                break;
            }
            p = d.parent();
        }
    }
    let tracked: Vec<String> = tracked.into_iter().collect();
    tracked.par_iter().filter_map(|d| stat_file(&root.join(d)).ok().map(|(_, m)| (d.clone(), m))).collect()
}

/// Build (or validate) the index for `root`.
pub fn build(root: &Path, opts: &BuildOptions) -> Result<BuildReport> {
    let root = absolutize(root);
    let dir = index_dir(&root);
    let _lock = if opts.validate_only { None } else { Some(BuildLock::acquire(&dir)?) };
    let t0 = Instant::now();
    let timing = std::env::var("SECT_TIMING").is_ok();
    let mut layer_ms: BTreeMap<String, u64> = BTreeMap::new();
    let mut stage = Instant::now();
    let lap = |name: &str, stage: &mut Instant, layer_ms: &mut BTreeMap<String, u64>| {
        let ms = stage.elapsed().as_millis() as u64;
        layer_ms.insert(name.to_string(), ms);
        if timing {
            eprintln!("timing: {name} {ms} ms");
        }
        *stage = Instant::now();
    };

    let sources = load_sources(&root)?;
    let resolver = Resolver::new(&sources);
    let files = walk_corpus(&root, &sources)?;
    let prev_manifest = load_manifest(&dir).ok();
    let prev = if opts.full { Store::default() } else { load_store(&dir) };
    let cache = if opts.full { HashMap::new() } else { load_docs_cache(&dir) };

    // Fingerprint diff: reuse a cached parse when the content hash is unchanged.
    let mut store = Store::default();
    let (mut added, mut changed) = (0usize, 0usize);
    let mut reparsed: HashSet<String> = HashSet::new();
    let mut issues: Vec<Issue> = Vec::new();
    let mut docs: Vec<Document> = Vec::with_capacity(files.len());
    let mut cache_hits = 0usize;
    for f in &files {
        let (size, mtime) = stat_file(&f.abs)?;
        let fp = match prev.files.get(&f.rel) {
            Some(p) if p.stat_matches(size, mtime) => p.clone(),
            _ => fingerprint_file(&f.abs)?,
        };
        let unchanged = prev.files.get(&f.rel).map(|p| p.blake3 == fp.blake3).unwrap_or(false);
        if prev.files.get(&f.rel).is_none() {
            added += 1;
        } else if !unchanged {
            changed += 1;
        }
        let cached = if unchanged { cache.get(&f.rel).filter(|c| c.blake3 == fp.blake3).map(|c| c.doc.clone()) } else { None };
        match cached {
            Some(d) => {
                cache_hits += 1;
                docs.push(d);
            }
            None => {
                reparsed.insert(f.rel.clone());
                match parse_document(f, &resolver) {
                    Ok(d) => docs.push(d),
                    Err(e) => issues.push(Issue { level: Level::Error, path: f.rel.clone(), message: e.to_string() }),
                }
            }
        }
        store.files.insert(f.rel.clone(), fp);
    }
    let removed_rels: Vec<String> = prev.files.keys().filter(|k| !store.files.contains_key(*k)).cloned().collect();
    let removed = removed_rels.len();
    store.dirs = snapshot_dirs(&root, &files, &sources);
    // Expressions whose chunks must leave the lexical and vector layers.
    let mut drop_exprs: HashSet<String> = HashSet::new();
    for rel in reparsed.iter().chain(removed_rels.iter()) {
        if let Some(c) = cache.get(rel) {
            if let Some(e) = c.doc.expr() {
                drop_exprs.insert(e);
            }
        }
    }
    lap("walk", &mut stage, &mut layer_ms);

    let embedding_spec = opts
        .embedding
        .clone()
        .or_else(|| prev_manifest.as_ref().and_then(|m| m.embedding_spec.clone()))
        .unwrap_or_else(|| sect_semantic::DEFAULT_MODEL.to_string());
    let want_semantic = embedding_spec != "none";
    let semantic_spec_changed = want_semantic && prev_manifest.as_ref().map(|m| m.embedding_spec.as_deref() != Some(embedding_spec.as_str())).unwrap_or(true);
    let mut report = BuildReport {
        mode: String::new(),
        files: files.len(),
        works: 0,
        expressions: 0,
        superseded: 0,
        sources: sources.len(),
        added,
        changed,
        removed,
        edges: 0,
        actions: 0,
        terms: 0,
        tables: 0,
        chunks: 0,
        unresolved_refs: 0,
        issues: Vec::new(),
        elapsed_ms: 0,
        layer_ms: BTreeMap::new(),
        validate_only: opts.validate_only,
        written: false,
    };

    // Nothing changed and every layer is on disk: no work (spec B.6, A.4 principle 3).
    let complete_cache = cache_hits == files.len();
    if !opts.full && !opts.validate_only && added + changed + removed == 0 && complete_cache && artifacts_present(&dir, want_semantic) && !semantic_spec_changed {
        report.mode = "noop".into();
        if let Some(m) = &prev_manifest {
            report.works = m.works;
            report.expressions = m.expressions;
            report.superseded = m.superseded;
            report.edges = m.edges;
            report.actions = m.actions;
            report.terms = m.terms;
            report.tables = m.tables;
            report.chunks = m.chunks;
            report.unresolved_refs = m.unresolved_refs;
        }
        report.elapsed_ms = t0.elapsed().as_millis();
        report.layer_ms = layer_ms;
        append_log(&dir, &serde_json::json!({"ts": now(), "action": "noop", "files": report.files, "elapsed_ms": report.elapsed_ms}));
        return Ok(report);
    }

    issues.extend(validate(&docs, &sources));
    lap("validate", &mut stage, &mut layer_ms);
    let tree = build_tree(&docs, &sources);
    if timing {
        eprintln!("timing: structural/tree {} ms", stage.elapsed().as_millis());
    }
    let graph = build_graph(&docs, &tree);
    if timing {
        eprintln!("timing: structural/tree+graph {} ms", stage.elapsed().as_millis());
    }
    let chunk_list = chunks::build_chunks(&docs, &tree);
    lap("structural", &mut stage, &mut layer_ms);
    let (works, expressions, superseded) = tree.counts();
    let unresolved: Vec<Edge> = graph.unresolved().into_iter().cloned().collect();
    report.works = works;
    report.expressions = expressions;
    report.superseded = superseded;
    report.edges = graph.edges.len();
    report.actions = graph.actions.len();
    report.terms = graph.terms.len();
    report.tables = graph.tables.len();
    report.chunks = chunk_list.len();
    report.unresolved_refs = unresolved.len();
    report.issues = issues;
    let errors = report.errors();
    if opts.validate_only || errors > 0 {
        report.mode = if opts.validate_only { "validate".into() } else { "blocked".into() };
        report.elapsed_ms = t0.elapsed().as_millis();
        report.layer_ms = layer_ms;
        if dir.is_dir() {
            append_log(&dir, &serde_json::json!({"ts": now(), "action": report.mode, "files": report.files, "added": added, "changed": changed, "removed": removed, "errors": errors, "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms}));
        }
        return Ok(report);
    }

    // A full rebuild of the layers when asked, when they are missing, or when the model changed.
    let full_layers = opts.full || !artifacts_present(&dir, false) || cache.is_empty();
    report.mode = if full_layers { "full".into() } else { "incremental".into() };
    std::fs::create_dir_all(&dir).map_err(|e| SectError::io(&dir, e))?;
    tree.save(&dir.join(TREE))?;
    graph.save(&dir)?;
    chunks::save(&dir.join(CHUNKS), &chunk_list)?;
    lap("write-structural", &mut stage, &mut layer_ms);

    let to_lex = |c: &Chunk| LexDoc {
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
    };
    let reparsed_exprs: HashSet<String> = docs.iter().filter(|d| reparsed.contains(&d.rel)).filter_map(|d| d.expr()).collect();
    let new_chunks: Vec<&Chunk> = chunk_list.iter().filter(|c| reparsed_exprs.contains(&c.expr)).collect();
    if full_layers {
        let lex_docs: Vec<LexDoc> = chunk_list.iter().map(to_lex).collect();
        sect_lexical::build(&dir.join(TANTIVY_DIR), &lex_docs)?;
    } else {
        let mut remove: Vec<String> = drop_exprs.iter().cloned().collect();
        remove.extend(reparsed_exprs.iter().cloned());
        let add: Vec<LexDoc> = new_chunks.iter().map(|c| to_lex(c)).collect();
        sect_lexical::update(&dir.join(TANTIVY_DIR), &remove, &add)?;
    }
    lap("lexical", &mut stage, &mut layer_ms);

    let mut embedding_name = prev_manifest.as_ref().and_then(|m| m.embedding.clone());
    let semantic_built = if !want_semantic {
        let _ = std::fs::remove_file(dir.join(VECTORS));
        embedding_name = None;
        false
    } else if full_layers || semantic_spec_changed || !dir.join(VECTORS).is_file() {
        // Network (hub fetch) happens here, at index time, never at query time. `provider_for`
        // refuses `remote:` specs unless a remote provider has been configured (opt-in).
        let provider = sect_semantic::provider_for(&embedding_spec)?;
        let target = embedding_spec.strip_prefix("model2vec:").unwrap_or(&embedding_spec).to_string();
        Model2VecProvider::materialize(&target, &dir.join(MODEL_DIR))?;
        let texts: Vec<String> = chunk_list.iter().map(|c| c.text.clone()).collect();
        let ids: Vec<String> = chunk_list.iter().map(|c| c.chunk_id.clone()).collect();
        let vectors = VectorIndex::build(provider.as_ref(), ids, &texts)?;
        vectors.save(&dir.join(VECTORS))?;
        embedding_name = Some(provider.name());
        true
    } else {
        let mut vectors = VectorIndex::load(&dir.join(VECTORS))?;
        let gone: HashSet<&String> = drop_exprs.iter().chain(reparsed_exprs.iter()).collect();
        vectors.retain(|id| !gone.contains(&id.split('#').next().unwrap_or(id).to_string()));
        if !new_chunks.is_empty() {
            // The model is loaded only when there is something new to embed, from the local copy.
            let provider: Box<dyn EmbeddingProvider> = Box::new(Model2VecProvider::load(&dir.join(MODEL_DIR).to_string_lossy())?);
            let ids: Vec<String> = new_chunks.iter().map(|c| c.chunk_id.clone()).collect();
            let texts: Vec<String> = new_chunks.iter().map(|c| c.text.clone()).collect();
            vectors.append(provider.as_ref(), ids, &texts)?;
        }
        vectors.save(&dir.join(VECTORS))?;
        true
    };
    lap("semantic", &mut stage, &mut layer_ms);

    // Caches and manifest.
    let mut cache_out = String::new();
    for d in &docs {
        let fp = &store.files[&d.rel];
        cache_out.push_str(&serde_json::to_string(&CachedDoc { rel: d.rel.clone(), blake3: fp.blake3.clone(), doc: d.clone() })?);
        cache_out.push('\n');
    }
    let cache_path = dir.join(DOCS_CACHE);
    std::fs::write(&cache_path, cache_out).map_err(|e| SectError::io(&cache_path, e))?;
    store.save(&dir)?;
    let mut per_source: BTreeMap<String, usize> = BTreeMap::new();
    for f in &files {
        *per_source.entry(f.source.clone()).or_default() += 1;
    }
    lap("write-caches", &mut stage, &mut layer_ms);
    report.elapsed_ms = t0.elapsed().as_millis();
    report.layer_ms = layer_ms.clone();
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
            .map(|s: &SourceConfig| SourceSummary { name: s.name.clone(), kind: s.kind.clone(), precedence: s.precedence, legal_status: s.legal_status.clone(), files: per_source.get(&s.name).copied().unwrap_or(0) })
            .collect(),
        layers: [("structural", true), ("exact", true), ("ngram", false), ("lexical", true), ("semantic", semantic_built)].into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        chunks: chunk_list.len(),
        embedding: embedding_name,
        embedding_spec: Some(embedding_spec.clone()),
        edges: graph.edges.len(),
        actions: graph.actions.len(),
        terms: graph.terms.len(),
        tables: graph.tables.len(),
        warnings: report.issues.iter().filter(|i| i.level == Level::Warning).cloned().collect(),
        unresolved_refs: unresolved.len(),
        unresolved,
        build_ms: report.elapsed_ms,
        mode: report.mode.clone(),
        layer_ms,
    };
    let m_path = dir.join(MANIFEST);
    std::fs::write(&m_path, serde_json::to_string_pretty(&manifest)?).map_err(|e| SectError::io(&m_path, e))?;
    append_log(&dir, &serde_json::json!({"ts": manifest.built_at, "action": report.mode, "files": report.files, "added": added, "changed": changed, "removed": removed, "errors": 0, "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms, "layer_ms": manifest.layer_ms}));
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

pub struct CheckResult {
    pub check: Check,
    pub manifest: Option<Manifest>,
    pub stat_ms: u64,
}

/// Stat every tracked file and directory against `fingerprints.json` in parallel, hashing only
/// the files whose stat moved. A changed directory mtime means something was added, removed, or
/// renamed there, which triggers a walk to count additions; when that walk finds nothing (an
/// add-then-remove) the stored directory mtimes are refreshed so the next query is fast again.
pub fn check(root: &Path) -> Result<CheckResult> {
    let t0 = Instant::now();
    let root = absolutize(root);
    let dir = index_dir(&root);
    let manifest = match load_manifest(&dir) {
        Ok(m) => m,
        Err(_) => return Ok(CheckResult { check: Check::Missing, manifest: None, stat_ms: 0 }),
    };
    let semantic = manifest.layers.get("semantic").copied().unwrap_or(false);
    if !artifacts_present(&dir, semantic) {
        return Ok(CheckResult { check: Check::Missing, manifest: None, stat_ms: 0 });
    }
    let timing = std::env::var("SECT_TIMING").is_ok();
    let t_manifest = t0.elapsed().as_micros();
    let bytes = std::fs::read(dir.join(FINGERPRINTS)).unwrap_or_default();
    let Some((file_lines, dir_lines)) = store_lines(&bytes) else {
        return Ok(CheckResult { check: Check::Stale { files: manifest.files, changed: manifest.files.max(1) }, manifest: Some(manifest), stat_ms: t0.elapsed().as_millis() as u64 });
    };
    let (nfiles, ndirs) = (file_lines.len(), dir_lines.len());
    let t_store = t0.elapsed().as_micros();
    // One parallel pass; each line is parsed on the thread that stats it: (changed files,
    // changed directories, unparsable lines).
    let file_check = |line: &&str| -> (usize, usize, usize) {
        let Ok((rel, size, mtime, hash)) = serde_json::from_str::<(Cow<str>, u64, u64, Cow<str>)>(line.trim_end_matches(',')) else { return (0, 0, 1) };
        match stat_file(&root.join(rel.as_ref())) {
            Err(_) => (1, 0, 0),
            Ok((s, m)) if s == size && m == mtime => (0, 0, 0),
            Ok(_) => match fingerprint_file(&root.join(rel.as_ref())) {
                Ok(f) if f.blake3 == hash.as_ref() => (0, 0, 0),
                _ => (1, 0, 0),
            },
        }
    };
    let dir_check = |line: &&str| -> (usize, usize, usize) {
        let Ok((rel, m)) = serde_json::from_str::<(Cow<str>, u64)>(line.trim_end_matches(',')) else { return (0, 0, 1) };
        match stat_file(&root.join(rel.as_ref())) {
            Ok((_, mt)) if mt == m => (0, 0, 0),
            _ => (0, 1, 0),
        }
    };
    let (changed, dirs_changed, bad) = stat_pool().install(|| {
        file_lines.par_iter().map(file_check).chain(dir_lines.par_iter().map(dir_check)).reduce(|| (0, 0, 0), |a, b| (a.0 + b.0, a.1 + b.1, a.2 + b.2))
    });
    let dir_changed = ndirs == 0 || dirs_changed > 0;
    let t_stat = t0.elapsed().as_micros();
    if timing {
        eprintln!("timing: check manifest {} us, store {} us, stat {} us ({} files, {} dirs), dir_changed {}", t_manifest, t_store - t_manifest, t_stat - t_store, nfiles, ndirs, dir_changed);
    }
    if bad > 0 {
        return Ok(CheckResult { check: Check::Stale { files: nfiles, changed: bad }, manifest: Some(manifest), stat_ms: t0.elapsed().as_millis() as u64 });
    }
    let mut added = 0usize;
    if dir_changed {
        let sources = load_sources(&root)?;
        let files = walk_corpus(&root, &sources)?;
        let store: StoreFile = serde_json::from_slice(&bytes).unwrap_or(StoreFile { columns: vec![], files: vec![], dirs: vec![] });
        let known: HashSet<&str> = store.files.iter().map(|(rel, ..)| rel.as_ref()).collect();
        added = files.iter().filter(|f| !known.contains(f.rel.as_str())).count();
        if added == 0 && changed == 0 && files.len() == store.files.len() && !lock_held(&root) {
            let mut owned = Store::from_file(store);
            owned.dirs = snapshot_dirs(&root, &files, &sources);
            let _ = owned.save(&dir);
            let stat_ms = t0.elapsed().as_millis() as u64;
            return Ok(CheckResult { check: Check::Fresh { files: nfiles }, manifest: Some(manifest), stat_ms });
        }
    }
    let total = changed + added;
    let stat_ms = t0.elapsed().as_millis() as u64;
    Ok(CheckResult { check: if total == 0 { Check::Fresh { files: nfiles } } else { Check::Stale { files: nfiles, changed: total } }, manifest: Some(manifest), stat_ms })
}

fn sync_limit() -> usize {
    std::env::var("SECT_SYNC_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(SYNC_LIMIT_DEFAULT)
}

/// Start `sect index <root>` as a detached process and return at once.
pub fn spawn_background(root: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let mut cmd = Command::new(exe);
    cmd.arg("index").arg(root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn().is_ok()
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

fn rebuild(root: &Path, dir: &Path, changed: usize, stat_ms: u64) -> Result<(Manifest, Freshness)> {
    let rep = build(root, &BuildOptions::default())?;
    if rep.errors() > 0 {
        return Err(SectError::Validation(rep.errors()));
    }
    let m = load_manifest(dir)?;
    let f = Freshness::Fresh { files: m.files, built_at: m.built_at.clone(), rebuilt: Some((changed.max(rep.changed_total()), rep.elapsed_ms as u64)), stat_ms };
    Ok((m, f))
}

/// Open the index for `root`. Missing: build. Fresh: answer. Stale: per `refresh`, answer as-is
/// (`No`), rebuild first (`Wait`), or refresh a small change set now and a large one in the
/// background (`Auto`).
pub fn open(root: &Path, refresh: Refresh) -> Result<Index> {
    let root = absolutize(root);
    let dir = index_dir(&root);
    let cr = check(&root)?;
    let (manifest, freshness) = match (cr.check, cr.manifest) {
        (Check::Missing, _) => rebuild(&root, &dir, 0, cr.stat_ms)?,
        (Check::Fresh { files }, Some(m)) => {
            let f = Freshness::Fresh { files, built_at: m.built_at.clone(), rebuilt: None, stat_ms: cr.stat_ms };
            (m, f)
        }
        (Check::Stale { files, changed }, Some(m)) => match refresh {
            Refresh::No => {
                let f = Freshness::PossiblyStale { files, changed, built_at: m.built_at.clone(), background: lock_held(&root), stat_ms: cr.stat_ms };
                (m, f)
            }
            Refresh::Wait => rebuild(&root, &dir, changed, cr.stat_ms)?,
            Refresh::Auto => {
                if changed <= sync_limit() && !lock_held(&root) {
                    rebuild(&root, &dir, changed, cr.stat_ms)?
                } else {
                    if !lock_held(&root) {
                        spawn_background(&root);
                    }
                    let f = Freshness::PossiblyStale { files, changed, built_at: m.built_at.clone(), background: true, stat_ms: cr.stat_ms };
                    (m, f)
                }
            }
        },
        (_, None) => unreachable!("check returns a manifest unless the index is missing"),
    };
    let tree = Tree::load(&dir.join(TREE))?;
    let graph = Graph::load(&dir)?;
    let sources = load_sources(&root)?;
    Ok(Index { root, manifest, tree, graph, freshness, sources })
}
