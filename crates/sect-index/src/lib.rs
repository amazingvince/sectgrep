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
pub mod compiled_cache;
mod freshness;
pub mod knowledge;
pub mod passages;
pub mod query_chunks;
pub mod regions;
mod scan_state;
pub mod search_state;
pub mod section_store;
pub use freshness::check;

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};
use rayon::prelude::*;
use sect_core::{
    Freshness, Refresh, Result, SectError, SourceConfig, INDEX_DIR, SCHEMA_VERSION, VERSION,
};
use sect_corpus::{
    fingerprint_file, load_sources, parse_document, split_front_matter, stat_file, validate,
    walk_corpus, Document, Fingerprint, Issue, Level, Resolver,
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
pub const SOURCES: &str = "sources.json";
pub const STRUCTURAL_FILES: &[&str] = &[
    "tree.json",
    "xrefs.jsonl",
    "actions.jsonl",
    "terms.json",
    "term-usages.json",
    "tables.jsonl",
    "chunks.jsonl",
    "knowledge.json",
    "regions.json",
    "sources.json",
];
/// Change sets up to this many files are refreshed synchronously by a query; larger ones go to a
/// background rebuild. `SECT_SYNC_LIMIT` overrides it.
pub const SYNC_LIMIT_DEFAULT: usize = 20;

#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    pub passage_policy: Option<passages::PassagePolicy>,
    /// Ignore stored fingerprints and caches and rebuild every layer.
    pub full: bool,
    /// Run the contract check only; write nothing (the check WS3 runs on staging).
    pub validate_only: bool,
    /// Embedding provider spec (`model2vec:<repo-or-path>`, a bare repo/path, or `none` to skip
    /// the semantic layer). None = the default potion-retrieval-32M.
    pub embedding: Option<String>,
    /// n-gram prefilter: `on`, `off`, or `auto` (on when the corpus is at least the threshold,
    /// spec B.4: 200 MB); None keeps what the index was built with (auto for a new index). An
    /// explicit value rebuilds the layer.
    pub ngram: Option<String>,
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
    pub passage_cache: compiled_cache::Stats,
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
        self.issues
            .iter()
            .filter(|i| i.level == Level::Error)
            .count()
    }
    pub fn warnings(&self) -> usize {
        self.issues
            .iter()
            .filter(|i| i.level == Level::Warning)
            .count()
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
    #[serde(default)]
    pub source_codec: String,
    #[serde(default)]
    pub graph_codec: String,
    pub schema_version: u32,
    #[serde(default)]
    pub generation: String,
    pub sect_version: String,
    pub built_at: String,
    /// New generations persist this date projection; older generations are projected on load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_date: Option<chrono::NaiveDate>,
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
    pub passage_policy: passages::PassagePolicy,
    #[serde(default)]
    pub passage_recipe: String,
    #[serde(default)]
    pub passage_cache: compiled_cache::Stats,
    #[serde(default)]
    pub document_store: bool,
    /// The `--ngram` setting this index was built with: on, off, or auto.
    #[serde(default)]
    pub ngram_spec: Option<String>,
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
            columns: ["rel", "size", "mtime_ns", "blake3"]
                .iter()
                .map(|c| Cow::Borrowed(*c))
                .collect(),
            files: self
                .files
                .iter()
                .map(|(k, f)| {
                    (
                        Cow::Borrowed(k.as_str()),
                        f.size,
                        f.mtime_ns,
                        Cow::Borrowed(f.blake3.as_str()),
                    )
                })
                .collect(),
            dirs: self
                .dirs
                .iter()
                .map(|(k, m)| (Cow::Borrowed(k.as_str()), *m))
                .collect(),
        }
    }
    fn from_file(f: StoreFile<'_>) -> Store {
        Store {
            files: f
                .files
                .into_iter()
                .map(|(k, size, mtime_ns, blake3)| {
                    (
                        k.into_owned(),
                        Fingerprint {
                            size,
                            mtime_ns,
                            blake3: blake3.into_owned(),
                        },
                    )
                })
                .collect(),
            dirs: f
                .dirs
                .into_iter()
                .map(|(k, m)| (k.into_owned(), m))
                .collect(),
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
    let base = root.join(INDEX_DIR);
    let newest = std::fs::read_dir(base.join("published"))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .filter(|n| n.ends_with(".ready"))
                .map(str::to_string)
        })
        .max();
    newest
        .map(|n| base.join("generations").join(n.trim_end_matches(".ready")))
        .unwrap_or(base)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|e| SectError::io(to, e))?;
    for entry in std::fs::read_dir(from).map_err(|e| SectError::io(from, e))? {
        let entry = entry.map_err(|e| SectError::io(from, e))?;
        let dest = to.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|e| SectError::io(entry.path(), e))?
            .is_dir()
        {
            copy_tree(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), &dest).map_err(|e| SectError::io(&dest, e))?;
        }
    }
    Ok(())
}

fn inputs(
    root: &Path,
    sources: &BTreeMap<String, SourceConfig>,
) -> Result<BTreeMap<String, PathBuf>> {
    let excluded = export_dirs(root, sources);
    let mut files: BTreeMap<String, PathBuf> =
        sect_exact::list_files_excluding(root, &[], &excluded)?
            .into_iter()
            .filter(|(p, _)| {
                !p.ends_with(".md")
                    || !sources.values().any(|s| {
                        s.input_mode == sect_core::source::InputMode::Document
                            && p.starts_with(&format!("{}/", s.dir))
                    })
            })
            .collect();
    for s in sources.values() {
        let rel = format!("{}/{}", s.dir.trim_end_matches('/'), sect_core::SOURCE_FILE);
        files.insert(rel.clone(), root.join(rel));
    }
    Ok(files)
}

fn export_dirs(root: &Path, sources: &BTreeMap<String, SourceConfig>) -> Vec<PathBuf> {
    sources
        .values()
        .filter(|s| s.input_mode == sect_core::source::InputMode::Document)
        .map(|s| root.join(&s.dir).join("exports"))
        .collect()
}

fn is_section_bundle(path: &str, sources: &BTreeMap<String, SourceConfig>) -> bool {
    path.ends_with(".sections.json")
        && sources.values().any(|s| {
            s.input_mode == sect_core::source::InputMode::Document
                && path.starts_with(&format!("{}/", s.dir))
        })
}

/// Make a corpus path absolute without `canonicalize` (which adds `\\?\` on Windows).
pub fn absolutize(root: &Path) -> PathBuf {
    if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|c| c.join(root))
            .unwrap_or_else(|_| root.to_path_buf())
    }
}

/// The stat pass runs on a pool of up to 16 threads: measured at 10k files, 16 threads stat in
/// 3.7 ms on ext4 (8: 5.2 ms, 32: 3.4 to 5.8 ms with the extra spawn cost) and in 75 ms on NTFS
/// (8: 104 ms, 32: 68 ms). `SECT_STAT_THREADS` overrides it.
fn stat_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let n = std::env::var("SECT_STAT_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|p| p.get())
                    .unwrap_or(4)
                    .clamp(2, 16)
            });
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build()
            .expect("stat thread pool")
    })
}

fn load_store(dir: &Path) -> Store {
    let bytes = std::fs::read(dir.join(FINGERPRINTS)).unwrap_or_default();
    serde_json::from_slice::<StoreFile>(&bytes)
        .ok()
        .map(Store::from_file)
        .unwrap_or_default()
}

fn load_docs_cache(dir: &Path) -> HashMap<String, CachedDoc> {
    let Ok(text) = std::fs::read_to_string(dir.join(DOCS_CACHE)) else {
        return HashMap::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<CachedDoc>(l).ok())
        .map(|c| (c.rel.clone(), c))
        .collect()
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
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(LOG))
    {
        let _ = writeln!(f, "{entry}");
    }
}

fn artifacts_present(dir: &Path, semantic: bool, manifest: &Manifest) -> bool {
    dir.join(MANIFEST).is_file()
        && {
            !manifest.document_store
                || (dir.join(section_store::CATALOG).is_file()
                    && dir.join("sections.bin").is_file())
        }
        && STRUCTURAL_FILES
            .iter()
            .filter(|f| {
                **f != "term-usages.json" || manifest.graph_codec == sect_struct::graph::GRAPH_CODEC
            })
            .all(|f| dir.join(f).is_file())
        && dir.join(TANTIVY_DIR).join("meta.json").is_file()
        && (!semantic || dir.join(VECTORS).is_file())
}

/// Exclusive build lock: `.sect/.lock`, created atomically; a second builder waits for it and a
/// lock older than ten minutes is treated as abandoned.
struct BuildLock(std::fs::File);

impl BuildLock {
    fn acquire(dir: &Path) -> Result<BuildLock> {
        std::fs::create_dir_all(dir).map_err(|e| SectError::io(dir, e))?;
        let path = dir.join(".lock");
        let started = Instant::now();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| SectError::io(&path, e))?;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(BuildLock(file)),
                Err(std::fs::TryLockError::WouldBlock) => {
                    if started.elapsed().as_secs() > 600 {
                        return Err(SectError::Other(format!(
                            "index build lock {} held for over ten minutes",
                            path.display()
                        )));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(std::fs::TryLockError::Error(e)) => return Err(SectError::io(&path, e)),
            }
        }
    }
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub fn lock_held(root: &Path) -> bool {
    let path = absolutize(root).join(INDEX_DIR).join(".lock");
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(f) => matches!(f.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        Err(_) => false,
    }
}

/// Directory snapshot for the stat pass: the root plus every directory that holds corpus
/// files, every source directory, and their ancestors, each stat'd directly. (NTFS updates the
/// timestamps a parent listing reports lazily, so listings are not trusted on any platform.)
fn snapshot_dirs(
    root: &Path,
    files: &[sect_corpus::CorpusFile],
    sources: &BTreeMap<String, SourceConfig>,
) -> BTreeMap<String, u64> {
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
    // Every directory grep's walk can reach is tracked too (ignore rules applied, hidden
    // skipped), so a file added anywhere grep would look marks the index stale and the n-gram
    // prefilter, whose file list is that walk, steps aside until the rebuild.
    let excluded = export_dirs(root, sources);
    for entry in ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .filter_entry(move |e| !excluded.iter().any(|p| e.path().starts_with(p)))
        .build()
        .flatten()
    {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                let s = rel.to_string_lossy().replace('\\', "/");
                if !s.is_empty() {
                    tracked.insert(s);
                }
            }
        }
    }
    let tracked: Vec<String> = tracked.into_iter().collect();
    tracked
        .par_iter()
        .filter_map(|d| stat_file(&root.join(d)).ok().map(|(_, m)| (d.clone(), m)))
        .collect()
}

/// Build (or validate) the index for `root`.
pub fn build(root: &Path, opts: &BuildOptions) -> Result<BuildReport> {
    let root = absolutize(root);
    let base = root.join(INDEX_DIR);
    if let Ok(token) = std::fs::read_to_string(base.join("merge.lock")) {
        if std::env::var("SECT_MERGE_TOKEN").ok().as_deref() != Some(token.as_str()) {
            return Err(SectError::Other(
                "corpus publication in progress; retry after merge".into(),
            ));
        }
    }
    let _lock = if opts.validate_only {
        None
    } else {
        Some(BuildLock::acquire(&base)?)
    };
    let dir = index_dir(&root);
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
    if timing {
        eprintln!(
            "timing: walk/files {} ms ({} files)",
            stage.elapsed().as_millis(),
            files.len()
        );
    }
    let prev_manifest = load_manifest(&dir).ok();
    let passage_policy = opts
        .passage_policy
        .clone()
        .or_else(|| prev_manifest.as_ref().map(|m| m.passage_policy.clone()))
        .unwrap_or_default();
    passage_policy.validate()?;
    let passage_changed = prev_manifest
        .as_ref()
        .is_none_or(|m| m.passage_recipe != passages::RECIPE || m.passage_policy != passage_policy);
    let source_codec_changed = prev_manifest
        .as_ref()
        .is_none_or(|m| m.source_codec != regions::SOURCE_CODEC);
    let graph_codec_changed = prev_manifest
        .as_ref()
        .is_none_or(|m| m.graph_codec != sect_struct::graph::GRAPH_CODEC);
    let prev = if opts.full {
        Store::default()
    } else {
        load_store(&dir)
    };
    let all_inputs = inputs(&root, &sources)?;
    if timing {
        eprintln!(
            "timing: walk/inputs {} ms ({} inputs)",
            stage.elapsed().as_millis(),
            all_inputs.len()
        );
    }
    // Parsed Markdown depends on its own bytes and the source registry used by the
    // citation resolver. Raw files, plain text and organized artifacts are validated
    // separately; changing one must not discard every unrelated Markdown parse.
    let is_registry = |rel: &str| {
        Path::new(rel)
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("_source.yaml"))
    };
    let registry_changed =
        all_inputs
            .iter()
            .filter(|(rel, _)| is_registry(rel))
            .any(|(rel, abs)| {
                fingerprint_file(abs)
                    .ok()
                    .map(|f| {
                        prev.files
                            .get(rel)
                            .map(|p| p.blake3 != f.blake3)
                            .unwrap_or(true)
                    })
                    .unwrap_or(true)
            })
            || prev
                .files
                .keys()
                .any(|rel| is_registry(rel) && !all_inputs.contains_key(rel));
    let cache = if opts.full
        || source_codec_changed
        || registry_changed
        || prev_manifest
            .as_ref()
            .map(|m| m.schema_version != SCHEMA_VERSION)
            .unwrap_or(true)
    {
        HashMap::new()
    } else {
        load_docs_cache(&dir)
    };

    // Fingerprint diff: reuse a cached parse when the content hash is unchanged.
    let mut store = Store::default();
    let (mut added, mut changed) = (0usize, 0usize);
    let mut issues: Vec<Issue> = Vec::new();
    let mut docs: Vec<Document> = Vec::with_capacity(files.len());
    let mut cache_hits = 0usize;
    // Indexed parallel iteration preserves corpus order, including validation errors.
    // Bound I/O concurrency with the same reusable pool used by freshness scans.
    let prepared = stat_pool().install(|| {
        files
            .par_iter()
            .map(|f| {
                let (size, mtime) = stat_file(&f.abs)?;
                let fp = match prev.files.get(&f.rel) {
                    Some(p) if p.stat_matches(size, mtime) => p.clone(),
                    _ => fingerprint_file(&f.abs)?,
                };
                let unchanged = prev
                    .files
                    .get(&f.rel)
                    .map(|p| p.blake3 == fp.blake3)
                    .unwrap_or(false);
                let cached = if unchanged {
                    cache
                        .get(&f.rel)
                        .filter(|c| c.blake3 == fp.blake3)
                        .map(|c| c.doc.clone())
                } else {
                    None
                };
                let was_cached = cached.is_some();
                let doc = cached
                    .map(Ok)
                    .unwrap_or_else(|| parse_document(f, &resolver));
                Ok((fp, unchanged, was_cached, doc))
            })
            .collect::<Vec<Result<_>>>()
    });
    if timing {
        eprintln!("timing: walk/parsed {} ms", stage.elapsed().as_millis());
    }
    for (f, prepared) in files.iter().zip(prepared) {
        let (fp, unchanged, was_cached, doc) = prepared?;
        if !prev.files.contains_key(&f.rel) {
            added += 1;
        } else if !unchanged {
            changed += 1;
        }
        if was_cached {
            cache_hits += 1;
        }
        match doc {
            Ok(d) => docs.push(d),
            Err(e) => issues.push(Issue {
                level: Level::Error,
                path: f.rel.clone(),
                message: e.to_string(),
            }),
        }
        store.files.insert(f.rel.clone(), fp);
    }
    for (rel, abs) in &all_inputs {
        if !store.files.contains_key(rel) {
            let fp = fingerprint_file(abs)?;
            match prev.files.get(rel) {
                None => added += 1,
                Some(p) if p.blake3 != fp.blake3 => changed += 1,
                _ => {}
            }
            store.files.insert(rel.clone(), fp);
        }
    }
    let virtual_inputs =
        section_store::load_inputs(&root, &sources, &all_inputs, &store.files, &resolver)?;
    if timing {
        eprintln!("timing: walk/collected {} ms", stage.elapsed().as_millis());
    }
    for (rel, input) in &virtual_inputs {
        if cache.get(rel).is_some_and(|c| c.blake3 == input.hash) {
            cache_hits += 1;
        }
        docs.push(input.doc.clone());
    }
    docs.sort_by(|a, b| a.rel.cmp(&b.rel));
    let removed_rels: Vec<String> = prev
        .files
        .keys()
        .filter(|k| !store.files.contains_key(*k))
        .cloned()
        .collect();
    let removed = removed_rels.len();
    if timing {
        eprintln!(
            "timing: walk/before-directories {} ms",
            stage.elapsed().as_millis()
        );
    }
    store.dirs = snapshot_dirs(&root, &files, &sources);
    // Current documents own their parses; the prior compiled inventory supplies removal
    // identities. Release old parse copies before building the large derived layers.
    drop(cache);
    lap("walk", &mut stage, &mut layer_ms);

    let embedding_spec = opts
        .embedding
        .clone()
        .or_else(|| {
            prev_manifest
                .as_ref()
                .and_then(|m| m.embedding_spec.clone())
        })
        .unwrap_or_else(|| sect_semantic::DEFAULT_MODEL.to_string());
    let want_semantic = embedding_spec != "none";
    let semantic_spec_changed = want_semantic
        && prev_manifest
            .as_ref()
            .map(|m| m.embedding_spec.as_deref() != Some(embedding_spec.as_str()))
            .unwrap_or(true);
    let ngram_spec: String = opts
        .ngram
        .clone()
        .or_else(|| prev_manifest.as_ref().and_then(|m| m.ngram_spec.clone()))
        .unwrap_or_else(|| "auto".into());
    let corpus_bytes: u64 = store.files.values().map(|f| f.size).sum();
    let want_ngram = match ngram_spec.as_str() {
        "on" => true,
        "off" => false,
        _ => corpus_bytes >= sect_ngram::threshold_bytes(),
    };
    let ngram_changed = opts.ngram.is_some()
        || prev_manifest
            .as_ref()
            .map(|m| m.layers.get("ngram").copied().unwrap_or(false) != want_ngram)
            .unwrap_or(want_ngram);
    let mut report = BuildReport {
        mode: String::new(),
        files: docs.len(),
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
        passage_cache: compiled_cache::Stats::default(),
        unresolved_refs: 0,
        issues: Vec::new(),
        elapsed_ms: 0,
        layer_ms: BTreeMap::new(),
        validate_only: opts.validate_only,
        written: false,
    };

    // Nothing changed and every layer is on disk: no work (spec B.6, A.4 principle 3).
    let complete_cache = cache_hits == docs.len();
    if !opts.full
        && !opts.validate_only
        && added + changed + removed == 0
        && complete_cache
        && prev_manifest
            .as_ref()
            .is_some_and(|m| artifacts_present(&dir, want_semantic, m))
        && !semantic_spec_changed
        && !ngram_changed
        && !source_codec_changed
        && !graph_codec_changed
        && !passage_changed
    {
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
        append_log(
            &dir,
            &serde_json::json!({"ts": now(), "action": "noop", "files": report.files, "elapsed_ms": report.elapsed_ms}),
        );
        return Ok(report);
    }

    issues.extend(validate(&docs, &sources));
    lap("validate", &mut stage, &mut layer_ms);
    // Contract failures must not spend time compiling passages or loading models.
    // Counts here describe the successfully parsed inputs; nothing is published.
    if issues.iter().any(|issue| issue.level == Level::Error) {
        report.mode = if opts.validate_only {
            "validate"
        } else {
            "blocked"
        }
        .into();
        report.works = docs
            .iter()
            .filter_map(Document::id)
            .collect::<HashSet<_>>()
            .len();
        report.expressions = docs
            .iter()
            .filter_map(Document::expr)
            .collect::<HashSet<_>>()
            .len();
        report.superseded = docs
            .iter()
            .filter(|d| d.front.superseded_by.is_some())
            .count();
        report.issues = issues;
        report.elapsed_ms = t0.elapsed().as_millis();
        report.layer_ms = layer_ms;
        if dir.is_dir() && !opts.validate_only {
            append_log(
                &dir,
                &serde_json::json!({"ts": now(), "action": report.mode, "files": report.files, "added": added, "changed": changed, "removed": removed, "errors": report.errors(), "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms}),
            );
        }
        return Ok(report);
    }
    let tree = build_tree(&docs, &sources);
    if timing {
        eprintln!("timing: structural/tree {} ms", stage.elapsed().as_millis());
    }
    let graph = build_graph(&docs, &tree);
    let mut artifacts = Vec::new();
    for (rel, abs) in &all_inputs {
        if rel.ends_with(".knowledge.json") || rel.ends_with("_knowledge.json") {
            artifacts.push(serde_json::from_slice::<
                sect_core::knowledge::KnowledgeArtifact,
            >(
                &std::fs::read(abs).map_err(|e| SectError::io(abs, e))?
            )?);
        }
    }
    knowledge::validate_raw(&root, &artifacts)?;
    let knowledge = knowledge::KnowledgeIndex::build(artifacts, &tree)?;
    let regions = regions::SourceIndex::build(&root, &all_inputs, &tree)?;
    if timing {
        eprintln!(
            "timing: structural/tree+graph {} ms",
            stage.elapsed().as_millis()
        );
    }
    let model_target = embedding_spec
        .strip_prefix("model2vec:")
        .unwrap_or(&embedding_spec);
    let prepared_provider = if want_semantic && !opts.validate_only {
        Some(sect_semantic::provider_for(&embedding_spec)?)
    } else {
        None
    };
    let budget = passages::Budget {
        policy: passage_policy.clone(),
        tokenizer: if prepared_provider.is_some() {
            Some(sect_semantic::TokenCounter::load(model_target)?)
        } else {
            None
        },
    };
    lap("structural", &mut stage, &mut layer_ms);
    // Parse-cache availability is independent of whether derived layers are reusable.
    // A missing/corrupt passage inventory does require full replacement of the layers.
    let previous_chunks = chunks::load(&dir.join(CHUNKS));
    let full_layers = opts.full
        || !prev_manifest.as_ref().is_some_and(|m| {
            m.schema_version == SCHEMA_VERSION && artifacts_present(&dir, false, m)
        })
        || previous_chunks.is_err();
    report.mode = if full_layers {
        "full".into()
    } else {
        "incremental".into()
    };
    let mut previous_chunks: HashMap<String, Chunk> = previous_chunks
        .unwrap_or_default()
        .into_iter()
        .map(|c| (c.chunk_id.clone(), c))
        .collect();
    let (chunk_list, compiled_cache, cache_stats, reused_passages) = compiled_cache::compile(
        &docs,
        &tree,
        &budget,
        &regions,
        compiled_cache::Previous {
            chunks: &mut previous_chunks,
            dir: &dir,
            reuse: !full_layers,
        },
        Utc::now().date_naive(),
    )?;
    report.passage_cache = cache_stats;
    lap("passages", &mut stage, &mut layer_ms);
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
        report.mode = if opts.validate_only {
            "validate".into()
        } else {
            "blocked".into()
        };
        report.elapsed_ms = t0.elapsed().as_millis();
        report.layer_ms = layer_ms;
        if dir.is_dir() && !opts.validate_only {
            append_log(
                &dir,
                &serde_json::json!({"ts": now(), "action": report.mode, "files": report.files, "added": added, "changed": changed, "removed": removed, "errors": errors, "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms}),
            );
        }
        return Ok(report);
    }

    let generation = format!(
        "{:020}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let next = base.join("generations").join(&generation);
    if !full_layers && dir != base {
        // Source snapshots are assembled below. Copying them here would duplicate all I/O.
        for entry in std::fs::read_dir(&dir).map_err(|e| SectError::io(&dir, e))? {
            let entry = entry.map_err(|e| SectError::io(&dir, e))?;
            if entry.file_name() == "corpus" || entry.file_name() == compiled_cache::FILE {
                continue;
            }
            let dest = next.join(entry.file_name());
            if entry
                .file_type()
                .map_err(|e| SectError::io(entry.path(), e))?
                .is_dir()
            {
                copy_tree(&entry.path(), &dest)?;
            } else {
                std::fs::create_dir_all(&next).map_err(|e| SectError::io(&next, e))?;
                std::fs::copy(entry.path(), dest).map_err(|e| SectError::io(entry.path(), e))?;
            }
        }
    }
    std::fs::create_dir_all(&next).map_err(|e| SectError::io(&next, e))?;
    let previous_dir = dir;
    let dir = next;
    // Source bytes are part of the generation. They cannot change underneath pinned readers.
    let snapshot = dir.join("corpus");
    for rel in &removed_rels {
        let _ = std::fs::remove_file(snapshot.join(rel));
    }
    all_inputs
        .par_iter()
        .try_for_each(|(rel, abs)| -> Result<()> {
            let dest = snapshot.join(rel);
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| SectError::io(&dest, e))?;
            let prior = previous_dir.join("corpus").join(rel);
            let reusable = prev
                .files
                .get(rel)
                .is_some_and(|p| p.blake3 == store.files[rel].blake3)
                && prior.is_file();
            if reusable {
                // Only immutable snapshot bytes may be linked. Never link a mutable source.
                if fingerprint_file(abs)?.blake3 != store.files[rel].blake3 {
                    return Err(SectError::Other(format!(
                        "input changed during build: {rel}; retry"
                    )));
                }
                if std::fs::hard_link(&prior, &dest).is_err() {
                    std::fs::copy(&prior, &dest).map_err(|e| SectError::io(&dest, e))?;
                }
            } else {
                std::fs::copy(abs, &dest).map_err(|e| SectError::io(&dest, e))?;
            }
            if fingerprint_file(&dest)?.blake3 != store.files[rel].blake3 {
                return Err(SectError::Other(format!(
                    "input changed during build: {rel}; retry"
                )));
            }
            Ok(())
        })?;
    std::fs::write(dir.join(SOURCES), serde_json::to_vec(&sources)?)
        .map_err(|e| SectError::io(dir.join(SOURCES), e))?;
    section_store::write(&dir, &virtual_inputs)?;
    let built_at = now();
    let tree_date = chrono::DateTime::parse_from_rfc3339(&built_at)
        .expect("build timestamp")
        .date_naive();
    tree.at(tree_date, &sources).save(&dir.join(TREE))?;
    graph.save(&dir)?;
    std::fs::write(
        dir.join("knowledge.json"),
        serde_json::to_vec(&knowledge.artifacts)?,
    )
    .map_err(|e| SectError::io(dir.join("knowledge.json"), e))?;
    std::fs::write(dir.join("regions.json"), serde_json::to_vec(&regions)?)
        .map_err(|e| SectError::io(dir.join("regions.json"), e))?;
    chunks::save(&dir.join(CHUNKS), &chunk_list)?;
    lap("write-structural", &mut stage, &mut layer_ms);

    let current_chunks: HashMap<&str, &Chunk> = chunk_list
        .iter()
        .map(|c| (c.chunk_id.as_str(), c))
        .collect();
    let changed_exprs: HashSet<String> = chunk_list
        .iter()
        .filter(|c| {
            !reused_passages.contains(&c.chunk_id) && previous_chunks.get(&c.chunk_id) != Some(*c)
        })
        .chain(
            previous_chunks
                .values()
                .filter(|c| current_chunks.get(c.chunk_id.as_str()).copied() != Some(*c)),
        )
        .flat_map(|c| std::iter::once(c.expr.clone()).chain(c.spans.iter().map(|s| s.expr.clone())))
        .collect();
    // Only changed/removed groups remain in the old inventory. Their removal identities
    // are now collected, so release their text before lexical/vector/n-gram work.
    drop(previous_chunks);
    drop(reused_passages);
    let new_chunks: Vec<&Chunk> = chunk_list
        .iter()
        .filter(|c| c.selected(&changed_exprs))
        .collect();
    if full_layers {
        let lex_docs: Vec<LexDoc> = chunk_list
            .iter()
            .flat_map(Chunk::lexical_documents)
            .collect();
        sect_lexical::build(&dir.join(TANTIVY_DIR), &lex_docs)?;
    } else {
        let remove: Vec<String> = changed_exprs.iter().cloned().collect();
        let add: Vec<LexDoc> = new_chunks
            .iter()
            .flat_map(|c| c.lexical_documents())
            .collect();
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
        let provider = prepared_provider
            .as_ref()
            .expect("semantic build prepared its provider");
        let target = embedding_spec
            .strip_prefix("model2vec:")
            .unwrap_or(&embedding_spec)
            .to_string();
        Model2VecProvider::materialize(&target, &dir.join(MODEL_DIR))?;
        let texts: Vec<String> = chunk_list
            .iter()
            .filter(|c| !c.navigation)
            .map(|c| c.text.clone())
            .collect();
        let ids: Vec<String> = chunk_list
            .iter()
            .filter(|c| !c.navigation)
            .map(|c| c.chunk_id.clone())
            .collect();
        let vectors = VectorIndex::build(provider.as_ref(), ids, &texts)?;
        vectors.save(&dir.join(VECTORS))?;
        embedding_name = Some(provider.name());
        true
    } else {
        let mut vectors = VectorIndex::load(&dir.join(VECTORS))?;
        let replacing: HashSet<&str> = new_chunks.iter().map(|c| c.chunk_id.as_str()).collect();
        vectors.retain(|id| current_chunks.contains_key(id) && !replacing.contains(id));
        if !new_chunks.is_empty() {
            // The model is loaded only when there is something new to embed, from the local copy.
            let provider = prepared_provider
                .as_ref()
                .expect("semantic build prepared its provider");
            let ids: Vec<String> = new_chunks
                .iter()
                .filter(|c| !c.navigation)
                .map(|c| c.chunk_id.clone())
                .collect();
            let texts: Vec<String> = new_chunks
                .iter()
                .filter(|c| !c.navigation)
                .map(|c| c.text.clone())
                .collect();
            vectors.append(provider.as_ref(), ids, &texts)?;
        }
        vectors.save(&dir.join(VECTORS))?;
        true
    };
    lap("semantic", &mut stage, &mut layer_ms);

    // n-gram prefilter: rebuilt whole whenever anything changed (file ids are positions in the
    // walk), only when wanted; removed otherwise.
    let ngram_dir = dir.join(sect_ngram::DIR);
    let ngram_built = if want_ngram {
        // Exactly the files grep walks (every file under the root that ignore rules admit, not
        // only the corpus sections), so the candidate list can never drop a file grep would read.
        let physical: BTreeMap<_, _> = sect_exact::list_files(&snapshot, &[])?
            .into_iter()
            .filter(|(p, _)| !is_section_bundle(p, &sources))
            .collect();
        let mut names: Vec<_> = physical
            .keys()
            .chain(virtual_inputs.keys())
            .cloned()
            .collect();
        names.sort();
        let stats = sect_ngram::build_with(&names, &ngram_dir, |i| {
            let p = &names[i];
            if let Some(input) = virtual_inputs.get(p) {
                return Ok(input.text.as_bytes().to_vec());
            }
            std::fs::read(&physical[p]).map_err(|e| SectError::io(p, e))
        })?;
        if timing {
            eprintln!(
                "timing: ngram {} grams, table {} bytes, postings {} bytes",
                stats.grams, stats.table_bytes, stats.postings_bytes
            );
        }
        true
    } else {
        let _ = std::fs::remove_dir_all(&ngram_dir);
        false
    };
    lap("ngram", &mut stage, &mut layer_ms);

    // Caches and manifest.
    compiled_cache.save(&dir)?;
    let mut cache_out = String::new();
    for d in &docs {
        let hash = virtual_inputs
            .get(&d.rel)
            .map(|v| &v.hash)
            .unwrap_or_else(|| &store.files[&d.rel].blake3);
        cache_out.push_str(&serde_json::to_string(&CachedDoc {
            rel: d.rel.clone(),
            blake3: hash.clone(),
            doc: d.clone(),
        })?);
        cache_out.push('\n');
    }
    let cache_path = dir.join(DOCS_CACHE);
    std::fs::write(&cache_path, cache_out).map_err(|e| SectError::io(&cache_path, e))?;
    store.save(&dir)?;
    let mut per_source: BTreeMap<String, usize> = BTreeMap::new();
    for f in &docs {
        *per_source.entry(f.source.clone()).or_default() += 1;
    }
    lap("write-caches", &mut stage, &mut layer_ms);
    report.elapsed_ms = t0.elapsed().as_millis();
    report.layer_ms = layer_ms.clone();
    let manifest = Manifest {
        source_codec: regions::SOURCE_CODEC.into(),
        graph_codec: sect_struct::graph::GRAPH_CODEC.into(),
        schema_version: SCHEMA_VERSION,
        generation: generation.clone(),
        sect_version: VERSION.to_string(),
        passage_policy,
        passage_recipe: passages::RECIPE.into(),
        passage_cache: report.passage_cache.clone(),
        document_store: sources
            .values()
            .any(|s| s.input_mode == sect_core::source::InputMode::Document),
        built_at,
        tree_date: Some(tree_date),
        corpus_root: root.to_string_lossy().replace('\\', "/"),
        files: docs.len(),
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
        layers: [
            ("structural", true),
            ("exact", true),
            ("ngram", ngram_built),
            ("lexical", true),
            ("semantic", semantic_built),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect(),
        chunks: chunk_list.len(),
        embedding: embedding_name,
        embedding_spec: Some(embedding_spec.clone()),
        ngram_spec: Some(ngram_spec.clone()),
        edges: graph.edges.len(),
        actions: graph.actions.len(),
        terms: graph.terms.len(),
        tables: graph.tables.len(),
        warnings: report
            .issues
            .iter()
            .filter(|i| i.level == Level::Warning)
            .cloned()
            .collect(),
        unresolved_refs: unresolved.len(),
        unresolved,
        build_ms: report.elapsed_ms,
        mode: report.mode.clone(),
        layer_ms,
    };
    let m_path = dir.join(MANIFEST);
    // A builder already running when the harness acquired its publication barrier must not
    // publish that intermediate view. The harness's own build carries the matching token.
    if let Ok(token) = std::fs::read_to_string(base.join("merge.lock")) {
        if std::env::var("SECT_MERGE_TOKEN").ok().as_deref() != Some(token.trim()) {
            return Err(SectError::Other(
                "merge began during build; previous generation retained".into(),
            ));
        }
    }
    std::fs::write(&m_path, serde_json::to_string_pretty(&manifest)?)
        .map_err(|e| SectError::io(&m_path, e))?;
    // Unique publication records avoid replacing an open file on Windows. Only complete
    // generations get a ready record; a failed build leaves the previous one selected.
    let published = base.join("published");
    std::fs::create_dir_all(&published).map_err(|e| SectError::io(&published, e))?;
    let pending = published.join(format!("{generation}.tmp"));
    let mut record = std::fs::File::create(&pending).map_err(|e| SectError::io(&pending, e))?;
    record
        .write_all(generation.as_bytes())
        .map_err(|e| SectError::io(&pending, e))?;
    record.sync_all().map_err(|e| SectError::io(&pending, e))?;
    drop(record);
    std::fs::rename(&pending, published.join(format!("{generation}.ready")))
        .map_err(|e| SectError::io(&published, e))?;
    append_log(
        &dir,
        &serde_json::json!({"ts": manifest.built_at, "action": report.mode, "files": report.files, "added": added, "changed": changed, "removed": removed, "errors": 0, "warnings": report.warnings(), "elapsed_ms": report.elapsed_ms, "layer_ms": manifest.layer_ms, "passage_cache": report.passage_cache}),
    );
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

#[derive(Clone)]
pub struct CheckResult {
    pub check: Check,
    pub manifest: Option<Manifest>,
    pub stat_ms: u64,
}

/// Stat every tracked file and directory against `fingerprints.json` in parallel, hashing only
/// the files whose stat moved. A changed directory mtime means something was added, removed, or
/// renamed there, which triggers a walk to count additions; when that walk finds nothing (an
/// add-then-remove) the stored directory mtimes are refreshed so the next query is fast again.
fn check_full(root: &Path) -> Result<CheckResult> {
    let t0 = Instant::now();
    let root = absolutize(root);
    let dir = index_dir(&root);
    let manifest = match load_manifest(&dir) {
        Ok(m) => m,
        Err(_) => {
            return Ok(CheckResult {
                check: Check::Missing,
                manifest: None,
                stat_ms: 0,
            })
        }
    };
    let semantic = manifest.layers.get("semantic").copied().unwrap_or(false);
    if manifest.schema_version != SCHEMA_VERSION || !artifacts_present(&dir, semantic, &manifest) {
        return Ok(CheckResult {
            check: Check::Missing,
            manifest: None,
            stat_ms: 0,
        });
    }
    if manifest.source_codec != regions::SOURCE_CODEC
        || manifest.graph_codec != sect_struct::graph::GRAPH_CODEC
        || manifest.passage_recipe != passages::RECIPE
    {
        return Ok(CheckResult {
            check: Check::Stale {
                files: manifest.files,
                changed: manifest.files.max(1),
            },
            manifest: Some(manifest),
            stat_ms: t0.elapsed().as_millis() as u64,
        });
    }
    let timing = std::env::var("SECT_TIMING").is_ok();
    let t_manifest = t0.elapsed().as_micros();
    let Some(plan) = scan_state::ScanState::load(&root, &dir) else {
        return Ok(CheckResult {
            check: Check::Stale {
                files: manifest.files,
                changed: manifest.files.max(1),
            },
            manifest: Some(manifest),
            stat_ms: t0.elapsed().as_millis() as u64,
        });
    };
    let (nfiles, ndirs) = (plan.files.len(), plan.dirs.len());
    let t_store = t0.elapsed().as_micros();
    let file_check = |file: &scan_state::File| -> (usize, usize) {
        match file.path.stat() {
            Err(_) => (1, 0),
            Ok((s, m)) if s == file.size && m == file.mtime => (0, 0),
            Ok(_) => match fingerprint_file(file.path.path()) {
                Ok(f) if f.blake3 == file.hash => (0, 0),
                _ => (1, 0),
            },
        }
    };
    let dir_check = |(path, mtime): &(sect_corpus::fingerprint::StatPath, u64)| -> (usize, usize) {
        match path.stat() {
            Ok((_, mt)) if mt == *mtime => (0, 0),
            _ => (0, 1),
        }
    };
    let (changed, dirs_changed) = stat_pool().install(|| {
        plan.files
            .par_iter()
            .map(file_check)
            .chain(plan.dirs.par_iter().map(dir_check))
            .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
    });
    let dir_changed = ndirs == 0 || dirs_changed > 0;
    let t_stat = t0.elapsed().as_micros();
    if timing {
        eprintln!("timing: check manifest {} us, store {} us, stat {} us ({} files, {} dirs), dir_changed {}", t_manifest, t_store - t_manifest, t_stat - t_store, nfiles, ndirs, dir_changed);
    }
    let mut added = 0usize;
    if dir_changed {
        let sources = load_sources(&root)?;
        let files = inputs(&root, &sources)?;
        let known: HashSet<&str> = plan.files.iter().map(|f| f.relative.as_str()).collect();
        added = files
            .keys()
            .filter(|rel| !known.contains(rel.as_str()))
            .count();
        if added == 0 && changed == 0 && files.len() == plan.files.len() && !lock_held(&root) {
            let stat_ms = t0.elapsed().as_millis() as u64;
            return Ok(CheckResult {
                check: Check::Fresh { files: nfiles },
                manifest: Some(manifest),
                stat_ms,
            });
        }
    }
    let total = changed + added;
    let stat_ms = t0.elapsed().as_millis() as u64;
    Ok(CheckResult {
        check: if total == 0 {
            Check::Fresh { files: nfiles }
        } else {
            Check::Stale {
                files: nfiles,
                changed: total,
            }
        },
        manifest: Some(manifest),
        stat_ms,
    })
}

fn sync_limit() -> usize {
    std::env::var("SECT_SYNC_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(SYNC_LIMIT_DEFAULT)
}

/// Start `sect index <root>` as a detached process and return at once.
pub fn spawn_background(root: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let mut cmd = Command::new(exe);
    cmd.arg("index")
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn().is_ok()
}

/// An opened index: manifest, tree, graph, and the freshness the caller must report first.
#[derive(Clone)]
pub struct Index {
    pub root: PathBuf,
    generation_dir: PathBuf,
    pub manifest: Manifest,
    pub tree: std::sync::Arc<Tree>,
    pub graph: std::sync::Arc<Graph>,
    pub knowledge: std::sync::Arc<knowledge::KnowledgeIndex>,
    pub freshness: Freshness,
    pub sources: BTreeMap<String, SourceConfig>,
    view_date: Option<chrono::NaiveDate>,
    handles: std::sync::Arc<Handles>,
}

#[derive(Default)]
struct Handles {
    sections: std::sync::Mutex<Option<std::sync::Arc<section_store::Store>>>,
    regions: std::sync::Mutex<Option<std::sync::Arc<regions::SourceIndex>>>,
    search: std::sync::Mutex<Option<std::sync::Arc<search_state::SearchState>>>,
    chunks: std::sync::Mutex<Option<std::sync::Arc<Vec<Chunk>>>>,
    lexical: std::sync::Mutex<Option<std::sync::Arc<sect_lexical::LexicalIndex>>>,
    vectors: std::sync::Mutex<Option<std::sync::Arc<VectorIndex>>>,
    model: std::sync::Mutex<Option<std::sync::Arc<dyn EmbeddingProvider>>>,
}
fn cached<T: ?Sized>(
    slot: &std::sync::Mutex<Option<std::sync::Arc<T>>>,
    load: impl FnOnce() -> Result<std::sync::Arc<T>>,
) -> Result<std::sync::Arc<T>> {
    let mut slot = slot
        .lock()
        .map_err(|_| SectError::Other("index handle lock poisoned".into()))?;
    if let Some(value) = &*slot {
        return Ok(value.clone());
    }
    let value = load()?;
    *slot = Some(value.clone());
    Ok(value)
}

impl Index {
    /// Source evidence is large and is needed by read/status, not ranked retrieval.
    pub fn regions(&self) -> Result<std::sync::Arc<regions::SourceIndex>> {
        cached(&self.handles.regions, || {
            let path = self.dir().join("regions.json");
            Ok(std::sync::Arc::new(serde_json::from_slice(
                &std::fs::read(&path).map_err(|e| SectError::io(&path, e))?,
            )?))
        })
    }
    pub fn search_state(&self) -> Result<std::sync::Arc<search_state::SearchState>> {
        cached(&self.handles.search, || {
            Ok(std::sync::Arc::new(search_state::SearchState::new(
                self,
                std::sync::Arc::new(query_chunks::load(&self.dir().join(CHUNKS))?),
            )))
        })
    }
    pub fn at(&self, date: chrono::NaiveDate) -> Index {
        let mut result = self.clone();
        if result.view_date != Some(date) {
            result.tree = std::sync::Arc::new(self.tree.at(date, &self.sources));
            result.view_date = Some(date);
        }
        result
    }
    pub fn snapshot_date(&self) -> chrono::NaiveDate {
        self.view_date.unwrap_or_else(|| {
            chrono::DateTime::parse_from_rfc3339(&self.manifest.built_at)
                .expect("build timestamp")
                .date_naive()
        })
    }
    pub fn snapshot_root(&self) -> PathBuf {
        self.generation_dir.join("corpus")
    }
    /// Body text of a section file (front matter stripped), read from disk at query time.
    pub fn read_body(&self, rel: &str) -> Result<String> {
        let text = self.read_text(rel)?;
        Ok(split_front_matter(&text)
            .map(|(_, b)| b.trim_end().to_string())
            .unwrap_or(text))
    }

    pub fn section_store(&self) -> Result<std::sync::Arc<section_store::Store>> {
        cached(&self.handles.sections, || {
            Ok(std::sync::Arc::new(section_store::Store::open(
                &self.generation_dir,
            )?))
        })
    }

    pub fn read_text(&self, rel: &str) -> Result<String> {
        if let Some(text) = self.section_store()?.text(rel)? {
            return Ok(text.to_string());
        }
        let path = self.snapshot_root().join(rel);
        std::fs::read_to_string(&path).map_err(|e| SectError::io(&path, e))
    }

    /// Raw corpus files plus virtual Markdown sections; the bundle encoding is not a second hit.
    pub fn grep(&self, opts: &sect_exact::GrepOptions) -> Result<sect_exact::GrepOutput> {
        if !self
            .sources
            .values()
            .any(|s| s.input_mode == sect_core::source::InputMode::Document)
        {
            return sect_exact::grep(&self.snapshot_root(), opts);
        }
        let store = self.section_store()?;
        let mut files: Vec<_> = sect_exact::list_files(&self.snapshot_root(), &[])?
            .into_iter()
            .filter(|(p, _)| !is_section_bundle(p, &self.sources))
            .map(|(p, a)| (p, sect_exact::Content::Path(a)))
            .collect();
        for path in store.paths() {
            files.push((
                path.clone(),
                sect_exact::Content::Bytes(store.text(path)?.expect("catalog path").as_bytes()),
            ));
        }
        sect_exact::grep_contents(&self.snapshot_root(), opts, files)
    }

    pub fn dir(&self) -> PathBuf {
        self.generation_dir.clone()
    }

    /// The chunk list (loaded on demand; only `search` needs it).
    pub fn chunks(&self) -> Result<std::sync::Arc<Vec<Chunk>>> {
        cached(&self.handles.chunks, || {
            Ok(std::sync::Arc::new(chunks::load(&self.dir().join(CHUNKS))?))
        })
    }

    pub fn lexical(&self) -> Result<std::sync::Arc<sect_lexical::LexicalIndex>> {
        cached(&self.handles.lexical, || {
            Ok(std::sync::Arc::new(sect_lexical::LexicalIndex::open(
                &self.dir().join(TANTIVY_DIR),
            )?))
        })
    }

    /// The n-gram prefilter, when the layer was built (spec B.4).
    pub fn prefilter(&self) -> Option<sect_ngram::Prefilter> {
        let dir = self.dir().join(sect_ngram::DIR);
        if self.manifest.layers.get("ngram").copied().unwrap_or(false)
            && sect_ngram::Prefilter::exists(&dir)
        {
            sect_ngram::Prefilter::open(&dir).ok()
        } else {
            None
        }
    }

    pub fn has_semantic(&self) -> bool {
        self.manifest
            .layers
            .get("semantic")
            .copied()
            .unwrap_or(false)
            && self.dir().join(VECTORS).is_file()
    }

    pub fn vectors(&self) -> Result<std::sync::Arc<VectorIndex>> {
        cached(&self.handles.vectors, || {
            Ok(std::sync::Arc::new(VectorIndex::load_mapped(
                &self.dir().join(VECTORS),
            )?))
        })
    }

    /// The embedding provider for queries: the model copied next to the index, so no network.
    pub fn embedder(&self) -> Result<std::sync::Arc<dyn EmbeddingProvider>> {
        let dir = self.dir().join(MODEL_DIR);
        if !dir.join("model.safetensors").is_file() {
            return Err(SectError::Other(format!(
                "no local embedding model under {}; run `sect index` to build the semantic layer",
                dir.display()
            )));
        }
        cached(&self.handles.model, || {
            Ok(std::sync::Arc::new(Model2VecProvider::load(
                &dir.to_string_lossy(),
            )?))
        })
    }
}

fn rebuild(
    root: &Path,
    _dir: &Path,
    changed: usize,
    stat_ms: u64,
) -> Result<(Manifest, Freshness)> {
    let rep = build(root, &BuildOptions::default())?;
    if rep.errors() > 0 {
        return Err(SectError::Validation(rep.errors()));
    }
    let m = load_manifest(&index_dir(root))?;
    let f = Freshness::Fresh {
        files: m.files,
        built_at: m.built_at.clone(),
        rebuilt: Some((changed.max(rep.changed_total()), rep.elapsed_ms as u64)),
        stat_ms,
    };
    Ok((m, f))
}

/// Open the index for `root`. Missing: build. Fresh: answer. Stale: per `refresh`, answer as-is
/// (`No`), rebuild first (`Wait`), or refresh a small change set now and a large one in the
/// background (`Auto`).
pub fn open(root: &Path, refresh: Refresh) -> Result<Index> {
    let root = absolutize(root);
    let refresh = if root.join(INDEX_DIR).join("merge.lock").exists() {
        Refresh::No
    } else {
        refresh
    };
    let dir = index_dir(&root);
    let cr = check(&root)?;
    let (manifest, freshness) = match (cr.check, cr.manifest) {
        (Check::Missing, _) => rebuild(&root, &dir, 0, cr.stat_ms)?,
        (Check::Fresh { files }, Some(m)) => {
            let f = Freshness::Fresh {
                files,
                built_at: m.built_at.clone(),
                rebuilt: None,
                stat_ms: cr.stat_ms,
            };
            (m, f)
        }
        (Check::Stale { files, changed }, Some(m)) => match refresh {
            Refresh::No => {
                let f = Freshness::PossiblyStale {
                    files,
                    changed,
                    built_at: m.built_at.clone(),
                    background: lock_held(&root),
                    stat_ms: cr.stat_ms,
                };
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
                    let f = Freshness::PossiblyStale {
                        files,
                        changed,
                        built_at: m.built_at.clone(),
                        background: true,
                        stat_ms: cr.stat_ms,
                    };
                    (m, f)
                }
            }
        },
        (_, None) => unreachable!("check returns a manifest unless the index is missing"),
    };
    let dir = root
        .join(INDEX_DIR)
        .join("generations")
        .join(&manifest.generation);
    // Retain the current generation for repeated library/MCP calls. Clones share all large
    // structures and lazy query handles; freshness is still checked for every open.
    static LAST: std::sync::OnceLock<std::sync::Mutex<Option<Index>>> = std::sync::OnceLock::new();
    let mut last = LAST
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| SectError::Other("index cache lock poisoned".into()))?;
    if let Some(previous) = &*last {
        if previous.generation_dir == dir {
            let mut result = previous.clone();
            result.freshness = freshness;
            return Ok(result);
        }
    }
    // These immutable artifacts are independent. Keep at most two loads in flight;
    // resolve errors in the same order as the former sequential loader.
    let (tree, graph) = rayon::join(|| Tree::load(&dir.join(TREE)), || Graph::load(&dir));
    let tree = tree?;
    let graph = graph?;
    let artifacts = serde_json::from_slice(
        &std::fs::read(dir.join("knowledge.json"))
            .map_err(|e| SectError::io(dir.join("knowledge.json"), e))?,
    )?;
    let knowledge = std::sync::Arc::new(knowledge::KnowledgeIndex::build(artifacts, &tree)?);
    let sources = serde_json::from_slice(
        &std::fs::read(dir.join(SOURCES)).map_err(|e| SectError::io(dir.join(SOURCES), e))?,
    )?;
    let view_date = manifest.tree_date;
    let index = Index {
        root,
        generation_dir: dir,
        manifest,
        tree: std::sync::Arc::new(tree),
        graph: std::sync::Arc::new(graph),
        knowledge,
        freshness,
        sources,
        view_date,
        handles: Default::default(),
    };
    let index = index.at(index.snapshot_date());
    *last = Some(index.clone());
    Ok(index)
}
