use std::path::Path;
use std::time::UNIX_EPOCH;

use sect_core::{Result, SectError};
use serde::{Deserialize, Serialize};

/// Content fingerprint plus the stat fields that let a query skip hashing unchanged files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub mtime_ns: u64,
    pub blake3: String,
}

pub fn stat_file(path: &Path) -> Result<(u64, u64)> {
    let md = std::fs::metadata(path).map_err(|e| SectError::io(path, e))?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    Ok((md.len(), mtime))
}

pub fn fingerprint_file(path: &Path) -> Result<Fingerprint> {
    let (size, mtime_ns) = stat_file(path)?;
    let bytes = std::fs::read(path).map_err(|e| SectError::io(path, e))?;
    Ok(Fingerprint { size, mtime_ns, blake3: blake3::hash(&bytes).to_hex().to_string() })
}

impl Fingerprint {
    /// True when size and mtime match, which is enough to skip re-hashing.
    pub fn stat_matches(&self, size: u64, mtime_ns: u64) -> bool {
        self.size == size && self.mtime_ns == mtime_ns
    }
}
