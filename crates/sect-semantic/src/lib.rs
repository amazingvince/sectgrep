//! Semantic index (spec B.4 "Semantic"): static embeddings from `model2vec-rs` with
//! `potion-retrieval-32M` (MIT weights) behind an [`EmbeddingProvider`] trait, and brute-force
//! cosine over an f32 matrix in `vectors.bin`. Remote providers are explicit opt-in and not wired.
//!
//! Network happens only at index time, when the model is fetched from the Hugging Face hub into
//! the standard cache and then copied next to the index (`.sect/semantic/model/`), so every query
//! loads the model from local files (decisions #29).

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use model2vec_rs::model::StaticModel;
use sect_core::{Result, SectError};
use serde::{Deserialize, Serialize};

pub const DEFAULT_MODEL: &str = "minishlab/potion-retrieval-32M";
pub const CANDIDATES: usize = 100;
const MODEL_FILES: &[&str] = &["tokenizer.json", "model.safetensors", "config.json"];
const MAGIC: &[u8; 8] = b"SECTVEC2";

pub trait EmbeddingProvider: Send + Sync {
    /// Provider spec as recorded in the manifest (e.g. `model2vec:minishlab/potion-retrieval-32M`).
    fn name(&self) -> String;
    fn dim(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

pub struct Model2VecProvider {
    model: StaticModel,
    name: String,
    dim: usize,
}

impl Model2VecProvider {
    /// Load from a local directory or a hub repo id. A repo id already in the standard Hugging
    /// Face cache (`HF_HOME` honoured) is loaded from its cached snapshot without any network;
    /// otherwise the hub is contacted (index time only).
    pub fn load(repo_or_path: &str) -> Result<Model2VecProvider> {
        let local = Path::new(repo_or_path).join("model.safetensors").is_file();
        let mut source: String = if local {
            repo_or_path.to_string()
        } else {
            snapshot_dir(repo_or_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| repo_or_path.to_string())
        };
        // A hub fetch: hold a lock so parallel sect processes do not download the same files at
        // once; whoever waits finds the snapshot in the cache afterwards.
        let _guard = if !local && source == repo_or_path {
            let g = DownloadLock::acquire(&hub_cache_dir())?;
            if let Some(p) = snapshot_dir(repo_or_path) {
                source = p.to_string_lossy().to_string();
            }
            Some(g)
        } else {
            None
        };
        let model = StaticModel::from_pretrained(&source, None, None, None)
            .map_err(|e| SectError::Other(format!("model2vec `{repo_or_path}`: {e}")))?;
        let dim = model.encode_single("dimension probe").len();
        Ok(Model2VecProvider {
            model,
            name: format!("model2vec:{repo_or_path}"),
            dim,
        })
    }

    /// Copy the three model files into `dir` so queries never touch the network. `repo_or_path`
    /// is either a local model directory or a hub repo already fetched into the standard cache
    /// (`HF_HUB_CACHE`, `HF_HOME/hub`, or `~/.cache/huggingface/hub`).
    pub fn materialize(repo_or_path: &str, dir: &Path) -> Result<PathBuf> {
        let src_dir = if Path::new(repo_or_path).join("model.safetensors").is_file() {
            PathBuf::from(repo_or_path)
        } else {
            snapshot_dir(repo_or_path).ok_or_else(|| {
                SectError::Other(format!(
                    "model `{repo_or_path}` not found in the Hugging Face cache after loading"
                ))
            })?
        };
        std::fs::create_dir_all(dir).map_err(|e| SectError::io(dir, e))?;
        for name in MODEL_FILES {
            let src = src_dir.join(name);
            std::fs::copy(&src, dir.join(name)).map_err(|e| SectError::io(&src, e))?;
        }
        Ok(dir.to_path_buf())
    }
}

/// Cross-process lock for hub downloads: `<hub cache>/.sect-download.lock`, created atomically;
/// waiters poll, and a lock older than ten minutes is treated as abandoned.
struct DownloadLock(PathBuf);

impl DownloadLock {
    fn acquire(dir: &Path) -> Result<DownloadLock> {
        std::fs::create_dir_all(dir).map_err(|e| SectError::io(dir, e))?;
        let path = dir.join(".sect-download.lock");
        let started = std::time::Instant::now();
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut f) => {
                    let _ = writeln!(f, "{}", std::process::id());
                    return Ok(DownloadLock(path));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(|t| t.elapsed().map(|d| d.as_secs() > 600).unwrap_or(false))
                        .unwrap_or(true);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed().as_secs() > 900 {
                        return Err(SectError::Other(format!(
                            "model download lock {} held for over fifteen minutes",
                            path.display()
                        )));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(SectError::io(&path, e)),
            }
        }
    }
}

impl Drop for DownloadLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn hub_cache_dir() -> PathBuf {
    if let Ok(c) = std::env::var("HF_HUB_CACHE") {
        return PathBuf::from(c);
    }
    if let Ok(h) = std::env::var("HF_HOME") {
        return PathBuf::from(h).join("hub");
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".cache")
        .join("huggingface")
        .join("hub")
}

/// The newest snapshot directory of a cached hub repo that holds the model files.
fn snapshot_dir(repo: &str) -> Option<PathBuf> {
    let snaps = hub_cache_dir()
        .join(format!("models--{}", repo.replace('/', "--")))
        .join("snapshots");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(snaps).ok()?.flatten() {
        let p = entry.path();
        if !MODEL_FILES.iter().all(|f| p.join(f).is_file()) {
            continue;
        }
        let t = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
            best = Some((t, p));
        }
    }
    best.map(|(_, p)| p)
}

impl EmbeddingProvider for Model2VecProvider {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn dim(&self) -> usize {
        self.dim
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        // The passage compiler owns the budget. The library's character heuristic followed
        // by token truncation used to discard the tail of otherwise searchable provisions.
        Ok(self.model.encode_with_args(texts, None, 256))
    }
}

/// A non-truncating counter from the exact model tokenizer, also usable without model weights.
pub struct TokenCounter(tokenizers::Tokenizer);
impl TokenCounter {
    pub fn load(repo_or_path: &str) -> Result<Self> {
        let source = if Path::new(repo_or_path).join("tokenizer.json").is_file() {
            PathBuf::from(repo_or_path)
        } else {
            snapshot_dir(repo_or_path)
                .ok_or_else(|| SectError::Other("tokenizer is not cached".into()))?
        };
        let mut tokenizer = tokenizers::Tokenizer::from_file(source.join("tokenizer.json"))
            .map_err(|e| SectError::Other(format!("tokenizer: {e}")))?;
        if tokenizer.get_truncation().is_some() {
            return Err(SectError::Other(
                "embedding tokenizer enables implicit truncation; use a non-truncating tokenizer"
                    .into(),
            ));
        }
        tokenizer.with_padding(None);
        Ok(Self(tokenizer))
    }

    /// Effective tokenizer configuration, including disabled padding and truncation.
    /// Callers may canonicalize and hash it to bind derived passage caches.
    pub fn configuration(&self) -> Result<String> {
        self.0
            .to_string(false)
            .map_err(|e| SectError::Other(format!("tokenizer: {e}")))
    }

    pub fn count(&self, text: &str) -> Result<usize> {
        self.0
            .encode(text, false)
            .map(|e| e.len())
            .map_err(|e| SectError::Other(format!("tokenizer: {e}")))
    }

    /// Suggest an original UTF-8 byte boundary using a single encoding. Callers
    /// must recount the prefix: normalization and subword merges can change its
    /// standalone token count. This method never enables tokenizer truncation.
    pub fn suggest_prefix_end(&self, text: &str, max: usize) -> Result<usize> {
        let encoding = self
            .0
            .encode(text, false)
            .map_err(|e| SectError::Other(format!("tokenizer: {e}")))?;
        if encoding.len() <= max {
            return Ok(text.len());
        }
        let mut end = encoding
            .get_offsets()
            .iter()
            .take(max)
            .map(|(_, end)| *end)
            .max()
            .unwrap_or(0)
            .min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(end)
    }
}

/// Resolve a provider spec: `model2vec:<repo-or-path>` (default), a bare repo/path (model2vec),
/// or `remote:<url>` which is opt-in and refused until a remote provider is configured.
pub fn provider_for(spec: &str) -> Result<Box<dyn EmbeddingProvider>> {
    if let Some(url) = spec.strip_prefix("remote:") {
        return Err(SectError::Other(format!("remote embedding providers are opt-in and none is configured (`{url}`); use a local model2vec model")));
    }
    let target = spec.strip_prefix("model2vec:").unwrap_or(spec);
    Ok(Box::new(Model2VecProvider::load(target)?))
}

fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

/// The vector matrix: one normalized row per chunk, in `ids` order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorIndex {
    pub model: String,
    pub dim: usize,
    pub ids: Vec<String>,
    #[serde(skip)]
    pub data: Vec<f32>,
    #[serde(skip)]
    mapped: Option<(std::sync::Arc<memmap2::Mmap>, usize, usize)>,
}

impl VectorIndex {
    fn values(&self) -> &[f32] {
        if let Some((map, offset, length)) = &self.mapped {
            // load_mapped checks alignment, native endianness and complete matrix bounds.
            // Published generations are immutable for the lifetime of every reader.
            unsafe { std::slice::from_raw_parts(map.as_ptr().add(*offset).cast::<f32>(), *length) }
        } else {
            &self.data
        }
    }
    pub fn build(
        provider: &dyn EmbeddingProvider,
        ids: Vec<String>,
        texts: &[String],
    ) -> Result<VectorIndex> {
        let dim = provider.dim();
        if dim == 0 || ids.len() != texts.len() {
            return Err(SectError::Other("invalid embedding batch shape".into()));
        }
        let mut data = Vec::with_capacity(ids.len() * dim);
        let embedded = provider.embed(texts)?;
        if embedded.len() != ids.len() {
            return Err(SectError::Other(
                "embedding provider returned the wrong row count".into(),
            ));
        }
        for mut v in embedded {
            if v.len() != dim {
                return Err(SectError::Other(format!(
                    "embedding dimension {} != {dim}",
                    v.len()
                )));
            }
            normalize(&mut v);
            data.extend_from_slice(&v);
        }
        Ok(VectorIndex {
            model: provider.name(),
            dim,
            ids,
            data,
            mapped: None,
        })
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Drop the rows whose id satisfies `pred` (incremental rebuild: chunks of changed or removed
    /// Expressions).
    pub fn retain<F: Fn(&str) -> bool>(&mut self, keep: F) {
        let dim = self.dim.max(1);
        let mut ids = Vec::with_capacity(self.ids.len());
        let mut data = Vec::with_capacity(self.values().len());
        for (i, id) in self.ids.iter().enumerate() {
            if keep(id) {
                ids.push(id.clone());
                data.extend_from_slice(&self.values()[i * dim..(i + 1) * dim]);
            }
        }
        self.ids = ids;
        self.data = data;
        self.mapped = None;
    }

    /// Append freshly embedded rows (normalized here).
    pub fn append(
        &mut self,
        provider: &dyn EmbeddingProvider,
        ids: Vec<String>,
        texts: &[String],
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        if self.mapped.is_some() {
            self.data = self.values().to_vec();
            self.mapped = None;
        }
        if provider.dim() != self.dim {
            return Err(SectError::Other(format!(
                "embedding dimension {} != index dimension {}",
                provider.dim(),
                self.dim
            )));
        }
        let embedded = provider.embed(texts)?;
        if ids.len() != texts.len()
            || embedded.len() != ids.len()
            || embedded.iter().any(|v| v.len() != self.dim)
        {
            return Err(SectError::Other(
                "embedding provider returned the wrong batch shape".into(),
            ));
        }
        for mut v in embedded {
            normalize(&mut v);
            self.data.extend_from_slice(&v);
        }
        self.ids.extend(ids);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// Brute-force cosine (dot product over normalized rows), top `k`, optionally restricted to
    /// an allowed set of row indices. Exact search is the intended path below ~1M vectors.
    pub fn search(
        &self,
        query: &[f32],
        k: usize,
        allowed: Option<&HashSet<usize>>,
    ) -> Vec<(usize, f32)> {
        if query.len() != self.dim || k == 0 {
            return vec![];
        }
        let mut q = query.to_vec();
        normalize(&mut q);
        let mut scored: Vec<(usize, f32)> = self
            .values()
            .chunks_exact(self.dim.max(1))
            .enumerate()
            .filter(|(i, _)| allowed.map(|a| a.contains(i)).unwrap_or(true))
            .map(|(i, row)| (i, row.iter().zip(q.iter()).map(|(a, b)| a * b).sum::<f32>()))
            .collect();
        let compare = |a: &(usize, f32), b: &(usize, f32)| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0))
        };
        if scored.len() > k {
            scored.select_nth_unstable_by(k, compare);
        }
        scored.truncate(k);
        scored.sort_by(compare);
        scored
    }

    /// `vectors.bin`: magic, dim, n, model name, ids, then the f32 matrix (little endian).
    pub fn save(&self, path: &Path) -> Result<()> {
        let mut f = std::fs::File::create(path).map_err(|e| SectError::io(path, e))?;
        let ids = self.ids.join("\n");
        let mut buf = Vec::with_capacity(32 + ids.len() + self.values().len() * 4);
        buf.extend_from_slice(MAGIC);
        buf.extend_from_slice(&(self.dim as u32).to_le_bytes());
        buf.extend_from_slice(&(self.ids.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.model.len() as u32).to_le_bytes());
        buf.extend_from_slice(self.model.as_bytes());
        buf.extend_from_slice(&(ids.len() as u32).to_le_bytes());
        buf.extend_from_slice(ids.as_bytes());
        while buf.len() % 4 != 0 {
            buf.push(0);
        }
        for x in self.values() {
            buf.extend_from_slice(&x.to_le_bytes());
        }
        f.write_all(&buf).map_err(|e| SectError::io(path, e))
    }

    pub fn load(path: &Path) -> Result<VectorIndex> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| SectError::io(path, e))?
            .read_to_end(&mut bytes)
            .map_err(|e| SectError::io(path, e))?;
        let bad = || SectError::Other(format!("{}: not a vectors.bin file", path.display()));
        if bytes.len() < 20 || (&bytes[..8] != MAGIC && &bytes[..8] != b"SECTVEC1") {
            return Err(bad());
        }
        let u32_at = |o: usize| -> usize {
            u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as usize
        };
        let dim = u32_at(8);
        let n = u32_at(12);
        let mlen = u32_at(16);
        let mut o = 20;
        let model = String::from_utf8(bytes.get(o..o + mlen).ok_or_else(bad)?.to_vec())
            .map_err(|_| bad())?;
        o += mlen;
        if bytes.len() < o + 4 {
            return Err(bad());
        }
        let ilen = u32_at(o);
        o += 4;
        let ids_text = String::from_utf8(bytes.get(o..o + ilen).ok_or_else(bad)?.to_vec())
            .map_err(|_| bad())?;
        o += ilen;
        if &bytes[..8] == MAGIC {
            o = (o + 3) & !3;
        }
        let ids: Vec<String> = if ids_text.is_empty() {
            vec![]
        } else {
            ids_text.split('\n').map(str::to_string).collect()
        };
        let length = n
            .checked_mul(dim)
            .and_then(|v| v.checked_mul(4))
            .and_then(|v| v.checked_add(o))
            .ok_or_else(bad)?;
        if dim == 0 || ids.len() != n || bytes.len() < length {
            return Err(bad());
        }
        let data: Vec<f32> = bytes[o..o + n * dim * 4]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        Ok(VectorIndex {
            model,
            dim,
            ids,
            data,
            mapped: None,
        })
    }

    /// Query readers use a read-only mapping of the aligned immutable v2 matrix.
    pub fn load_mapped(path: &Path) -> Result<VectorIndex> {
        let file = std::fs::File::open(path).map_err(|e| SectError::io(path, e))?;
        // The caller opens only immutable generation files, never a writer's staging file.
        let map = unsafe { memmap2::MmapOptions::new().map(&file) }
            .map_err(|e| SectError::io(path, e))?;
        let bad = || SectError::Other(format!("{}: invalid mapped vectors", path.display()));
        if map.len() < 20 {
            return Err(bad());
        }
        if &map[..8] != MAGIC || !cfg!(target_endian = "little") {
            return Self::load(path);
        }
        let word = |o: usize| -> Result<usize> {
            Ok(u32::from_le_bytes(map.get(o..o + 4).ok_or_else(bad)?.try_into().unwrap()) as usize)
        };
        let dim = word(8)?;
        let n = word(12)?;
        let model_end = 20usize.checked_add(word(16)?).ok_or_else(bad)?;
        let model = std::str::from_utf8(map.get(20..model_end).ok_or_else(bad)?)
            .map_err(|_| bad())?
            .to_string();
        let ids_start = model_end + 4;
        let ids_end = ids_start.checked_add(word(model_end)?).ok_or_else(bad)?;
        let text =
            std::str::from_utf8(map.get(ids_start..ids_end).ok_or_else(bad)?).map_err(|_| bad())?;
        let ids: Vec<String> = if text.is_empty() {
            vec![]
        } else {
            text.split('\n').map(str::to_string).collect()
        };
        let offset = (ids_end + 3) & !3;
        let length = n.checked_mul(dim).ok_or_else(bad)?;
        let end = length
            .checked_mul(4)
            .and_then(|v| v.checked_add(offset))
            .ok_or_else(bad)?;
        if dim == 0
            || ids.len() != n
            || end > map.len()
            || !(map.as_ptr() as usize + offset).is_multiple_of(std::mem::align_of::<f32>())
        {
            return Err(bad());
        }
        Ok(Self {
            model,
            dim,
            ids,
            data: vec![],
            mapped: Some((std::sync::Arc::new(map), offset, length)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl EmbeddingProvider for Fake {
        fn name(&self) -> String {
            "fake".into()
        }
        fn dim(&self) -> usize {
            3
        }
        fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|t| {
                    vec![
                        t.matches('a').count() as f32,
                        t.matches('b').count() as f32,
                        1.0,
                    ]
                })
                .collect())
        }
    }

    #[test]
    fn roundtrip_and_brute_force_search() {
        let ids = vec!["x#c0".to_string(), "y#c0".to_string(), "z#c0".to_string()];
        let texts = vec!["aaaa".to_string(), "bbbb".to_string(), "ab".to_string()];
        let vi = VectorIndex::build(&Fake, ids.clone(), &texts).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("vectors.bin");
        vi.save(&p).unwrap();
        let back = VectorIndex::load(&p).unwrap();
        assert_eq!(back.ids, ids);
        assert_eq!(back.dim, 3);
        assert_eq!(back.data.len(), 9);
        let q = Fake.embed(&["aaa".to_string()]).unwrap().remove(0);
        let hits = back.search(&q, 2, None);
        assert_eq!(hits[0].0, 0, "closest to the a-heavy row: {hits:?}");
        let allowed = HashSet::from([1usize, 2]);
        let hits = back.search(&q, 2, Some(&allowed));
        assert_eq!(hits[0].0, 2);
        let mapped = VectorIndex::load_mapped(&p).unwrap();
        assert!(mapped.mapped.is_some());
        assert_eq!(mapped.search(&q, 2, Some(&allowed)), hits);
        assert_eq!(mapped.values(), back.data);
        let bytes = std::fs::read(&p).unwrap();
        let broken = tmp.path().join("broken.bin");
        for cut in 0..bytes.len() {
            std::fs::write(&broken, &bytes[..cut]).unwrap();
            assert!(VectorIndex::load_mapped(&broken).is_err(), "cut {cut}");
        }
        assert!(provider_for("remote:https://example.invalid").is_err());
        // Incremental: drop one row, append one.
        let mut inc = back.clone();
        inc.retain(|id| id != "y#c0");
        inc.append(&Fake, vec!["w#c0".to_string()], &["aab".to_string()])
            .unwrap();
        assert_eq!(inc.ids, vec!["x#c0", "z#c0", "w#c0"]);
        assert_eq!(inc.data.len(), 9);
        let hits = inc.search(&q, 1, None);
        assert_eq!(inc.ids[hits[0].0], "x#c0");
    }
}
