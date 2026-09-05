//! Conservative full scans by default; opt-in native notification reuse on local NTFS.
//!
//! Notifications describe writes observed by the filesystem, not arbitrary external aliases
//! or unflushed/mapped writes. Keep `SECT_FRESHNESS_WATCH=1` experimental; correctness-critical
//! callers retain the full scan. Errors, signals, root changes and expiry always rescan.
//! Both paths use metadata to decide when to hash. Same-size writes with restored
//! mtimes require `index --full`; a full metadata scan is not content verification.
use crate::{CheckResult, Result};
use std::path::Path;

pub fn check(root: &Path) -> Result<CheckResult> {
    #[cfg(windows)]
    if std::env::var("SECT_FRESHNESS_WATCH").as_deref() == Ok("1") {
        return windows::check(root);
    }
    crate::check_full(root)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::{absolutize, Check};
    use std::collections::VecDeque;
    use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    struct Watch(HANDLE);
    // The handle has a single owner, and all waits/rearming happen under CACHE's mutex.
    unsafe impl Send for Watch {}
    impl Drop for Watch {
        fn drop(&mut self) {
            // SAFETY: this is a live, uniquely owned change-notification handle.
            unsafe {
                FindCloseChangeNotification(self.0);
            }
        }
    }
    impl Watch {
        fn new(path: &Path, recursive: bool) -> Option<Self> {
            let path = wide(path);
            // SAFETY: path is a live NUL-terminated buffer; no output pointers are retained.
            let handle = unsafe {
                FindFirstChangeNotificationW(
                    path.as_ptr(),
                    recursive.into(),
                    FILE_NOTIFY_CHANGE_FILE_NAME
                        | FILE_NOTIFY_CHANGE_DIR_NAME
                        | FILE_NOTIFY_CHANGE_ATTRIBUTES
                        | FILE_NOTIFY_CHANGE_SIZE
                        | FILE_NOTIFY_CHANGE_LAST_WRITE
                        | FILE_NOTIFY_CHANGE_SECURITY,
                )
            };
            (handle != INVALID_HANDLE_VALUE && !handle.is_null()).then_some(Self(handle))
        }
        fn pending(&self) -> Option<bool> {
            // SAFETY: the owner keeps the handle open for the entire nonblocking wait.
            match unsafe { WaitForSingleObject(self.0, 0) } {
                WAIT_TIMEOUT => Some(false),
                WAIT_OBJECT_0 => Some(true),
                _ => None,
            }
        }
        fn rearm_if_signaled(&self) -> Option<()> {
            if self.pending()? {
                // SAFETY: only rearm after a successful signaled wait, per the Win32 contract.
                if unsafe { FindNextChangeNotification(self.0) } == 0 {
                    return None;
                }
            }
            Some(())
        }
    }
    fn supported(root: &Path) -> bool {
        // Reject redirected roots. The normal corpus walk does not follow symlink entries.
        for ancestor in root.ancestors() {
            let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
                return false;
            };
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return false;
            }
        }
        let path = wide(root);
        let mut volume = vec![0u16; 32768];
        let mut fs_name = [0u16; 32];
        // SAFETY: all buffers have their advertised capacity; unused output fields are null.
        unsafe {
            if GetVolumePathNameW(path.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) == 0
                || GetDriveTypeW(volume.as_ptr()) != 3
            {
                return false;
            } // DRIVE_FIXED
            if GetVolumeInformationW(
                volume.as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs_name.as_mut_ptr(),
                fs_name.len() as u32,
            ) == 0
            {
                return false;
            }
        }
        String::from_utf16_lossy(
            &fs_name[..fs_name
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(fs_name.len())],
        ) == "NTFS"
    }
    struct Entry {
        root: PathBuf,
        watch: Watch,
        parent: Watch,
        fresh: Option<CheckResult>,
        scanned: Instant,
    }
    impl Entry {
        fn new(root: PathBuf) -> Option<Self> {
            if !supported(&root) {
                return None;
            }
            let watch = Watch::new(&root, true)?;
            let parent = Watch::new(root.parent()?, false)?;
            Some(Self {
                root,
                watch,
                parent,
                fresh: None,
                scanned: Instant::now(),
            })
        }
        fn quiet(&self) -> Option<bool> {
            Some(!self.watch.pending()? && !self.parent.pending()?)
        }
        fn reset(&self) -> Option<()> {
            self.watch.rearm_if_signaled()?;
            self.parent.rearm_if_signaled()
        }
    }
    pub(super) fn check(root: &Path) -> Result<CheckResult> {
        static CACHE: OnceLock<Mutex<VecDeque<Entry>>> = OnceLock::new();
        let start = Instant::now();
        let root = absolutize(root);
        let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() else {
            return crate::check_full(&root);
        };
        let mut entry = if let Some(i) = cache.iter().position(|e| e.root == root) {
            cache.remove(i).expect("position exists")
        } else if let Some(entry) = Entry::new(root.clone()) {
            entry
        } else {
            return crate::check_full(&root);
        };
        // A parent event can mean the watched root was replaced. Re-subscribe to its
        // current identity before validating, rather than retaining a handle to the old root.
        if entry.parent.pending() != Some(false) {
            let Some(replacement) = Entry::new(root.clone()) else {
                return crate::check_full(&root);
            };
            entry = replacement;
        }
        let quiet = entry.quiet();
        if quiet == Some(true) && entry.scanned.elapsed() < Duration::from_secs(60) {
            if let Some(result) = &entry.fresh {
                let mut result = result.clone();
                result.stat_ms = start.elapsed().as_millis() as u64;
                if std::env::var("SECT_TIMING").is_ok() {
                    eprintln!("timing: freshness native notification cache");
                }
                cache.push_back(entry);
                return Ok(result);
            }
        }
        if quiet.is_none() || entry.reset().is_none() {
            return crate::check_full(&root);
        }
        let result = crate::check_full(&root)?;
        entry.fresh = (matches!(result.check, Check::Fresh { .. }) && entry.quiet() == Some(true))
            .then(|| result.clone());
        entry.scanned = Instant::now();
        if cache.len() == 4 {
            cache.pop_front();
        }
        cache.push_back(entry);
        Ok(result)
    }
}
