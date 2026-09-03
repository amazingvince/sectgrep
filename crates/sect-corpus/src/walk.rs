use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use sect_core::{Result, SectError, SourceConfig, SOURCE_FILE};

/// One markdown file in the corpus.
#[derive(Debug, Clone)]
pub struct CorpusFile {
    /// Path relative to the corpus root, forward slashes.
    pub rel: String,
    pub abs: PathBuf,
    pub source: String,
}

pub fn rel_string(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root).unwrap_or(abs).to_string_lossy().replace('\\', "/")
}

/// Every direct subdirectory of `root` that holds a `_source.yaml` is a source.
pub fn load_sources(root: &Path) -> Result<BTreeMap<String, SourceConfig>> {
    let mut out = BTreeMap::new();
    let entries = std::fs::read_dir(root).map_err(|e| SectError::io(root, e))?;
    let mut dirs: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for dir in dirs {
        let sy = dir.join(SOURCE_FILE);
        if !sy.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&sy).map_err(|e| SectError::io(&sy, e))?;
        let mut cfg: SourceConfig = serde_yaml_ng::from_str(&text)
            .map_err(|e| SectError::FrontMatter { path: sy.clone(), message: e.to_string() })?;
        if cfg.name.is_empty() {
            cfg.name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        }
        cfg.dir = rel_string(root, &dir);
        out.insert(cfg.name.clone(), cfg);
    }
    if out.is_empty() {
        return Err(SectError::NotACorpus(root.to_path_buf()));
    }
    Ok(out)
}

/// All `*.md` files under the source directories, sorted by relative path. Hidden directories
/// (including `.sect/`) and gitignored files are skipped.
pub fn walk_corpus(root: &Path, sources: &BTreeMap<String, SourceConfig>) -> Result<Vec<CorpusFile>> {
    let mut files = Vec::new();
    for src in sources.values() {
        let dir = root.join(&src.dir);
        for entry in WalkBuilder::new(&dir).hidden(true).git_ignore(true).sort_by_file_path(|a, b| a.cmp(b)).build() {
            let entry = entry.map_err(|e| SectError::Other(format!("walk {}: {e}", dir.display())))?;
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            files.push(CorpusFile { rel: rel_string(root, path), abs: path.to_path_buf(), source: src.name.clone() });
        }
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(files)
}
