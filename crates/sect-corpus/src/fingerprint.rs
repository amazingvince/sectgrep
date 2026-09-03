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

/// One attribute query per path. Rust's `fs::metadata` on Windows opens a handle (three
/// syscalls) so that reparse points resolve; the freshness stat of 10k files cannot afford that
/// (spec B.6: < 10 ms), and `GetFileAttributesExW` yields the same size and mtime for regular
/// files and directories. The mtime is in the same units `SystemTime` would give.
#[cfg(windows)]
fn stat_fast(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesExW, GetFileExInfoStandard, WIN32_FILE_ATTRIBUTE_DATA};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut data: WIN32_FILE_ATTRIBUTE_DATA = unsafe { std::mem::zeroed() };
    // SAFETY: `wide` is null-terminated and `data` is a valid out-pointer of the requested class.
    let ok = unsafe { GetFileAttributesExW(wide.as_ptr(), GetFileExInfoStandard, &mut data as *mut _ as *mut core::ffi::c_void) };
    if ok == 0 {
        return None;
    }
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000; // 100-ns intervals from 1601-01-01 to 1970-01-01
    let ft = ((data.ftLastWriteTime.dwHighDateTime as u64) << 32) | data.ftLastWriteTime.dwLowDateTime as u64;
    let size = ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64;
    Some((size, ft.saturating_sub(EPOCH_DIFF) * 100))
}

pub fn stat_file(path: &Path) -> Result<(u64, u64)> {
    #[cfg(windows)]
    if let Some(s) = stat_fast(path) {
        return Ok(s);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_agrees_with_std_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("a.md");
        std::fs::write(&f, "hello").unwrap();
        let (size, mtime) = stat_file(&f).unwrap();
        let md = std::fs::metadata(&f).unwrap();
        assert_eq!(size, md.len());
        assert_eq!(mtime, md.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64);
        assert!(stat_file(tmp.path()).is_ok(), "directories stat too");
        assert!(stat_file(&tmp.path().join("missing")).is_err());
    }
}
