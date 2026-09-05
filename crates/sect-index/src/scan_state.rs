//! Cache the immutable scan plan, never the filesystem observations used by the default check.
use crate::{stat_file, StoreFile, FINGERPRINTS};
use sect_corpus::fingerprint::StatPath;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub struct File {
    pub relative: String,
    pub path: StatPath,
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
}
pub struct ScanState {
    root: PathBuf,
    directory: PathBuf,
    stamp: (u64, u64),
    pub files: Vec<File>,
    pub dirs: Vec<(StatPath, u64)>,
}
impl ScanState {
    pub fn load(root: &Path, directory: &Path) -> Option<Arc<Self>> {
        static LAST: OnceLock<Mutex<Option<Arc<ScanState>>>> = OnceLock::new();
        let path = directory.join(FINGERPRINTS);
        let stamp = stat_file(&path).ok()?;
        let mut cache = LAST.get_or_init(Default::default).lock().ok()?;
        if let Some(state) = &*cache {
            if state.root == root && state.directory == directory && state.stamp == stamp {
                return Some(state.clone());
            }
        }
        let bytes = std::fs::read(&path).ok()?;
        let store: StoreFile = serde_json::from_slice(&bytes).ok()?;
        let state = Arc::new(Self {
            root: root.to_path_buf(),
            directory: directory.to_path_buf(),
            stamp,
            files: store
                .files
                .into_iter()
                .map(|(rel, size, mtime, hash)| File {
                    path: StatPath::new(root.join(rel.as_ref())),
                    relative: rel.into_owned(),
                    size,
                    mtime,
                    hash: hash.into_owned(),
                })
                .collect(),
            dirs: store
                .dirs
                .into_iter()
                .map(|(rel, mtime)| (StatPath::new(root.join(rel.as_ref())), mtime))
                .collect(),
        });
        *cache = Some(state.clone());
        Some(state)
    }
}
