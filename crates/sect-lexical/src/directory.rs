//! Preserve the actual failing operation when Tantivy wraps a metadata-write error
//! as an error on the segment it was registering.
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tantivy::directory::{
    error::{DeleteError, LockError, OpenReadError, OpenWriteError},
    Directory, DirectoryLock, FileHandle, Lock, MmapDirectory, WatchCallback, WatchHandle,
    WritePtr,
};

#[derive(Clone, Debug)]
pub(crate) struct IndexDirectory {
    inner: MmapDirectory,
    root: PathBuf,
}

impl IndexDirectory {
    pub(crate) fn open(path: &Path) -> tantivy::Result<Self> {
        Ok(Self {
            inner: MmapDirectory::open(path)?,
            root: path.to_owned(),
        })
    }

    fn report<T, E: std::fmt::Debug>(
        &self,
        operation: &str,
        path: &Path,
        result: Result<T, E>,
    ) -> Result<T, E> {
        if let Err(error) = &result {
            eprintln!(
                "lexical directory {operation} {}: {error:?}",
                self.root.join(path).display()
            );
        }
        result
    }
}

impl Directory for IndexDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
        self.inner.get_file_handle(path)
    }
    fn delete(&self, path: &Path) -> Result<(), DeleteError> {
        self.inner.delete(path)
    }
    fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
        self.inner.exists(path)
    }
    fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
        self.report("open_write", path, self.inner.open_write(path))
    }
    fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
        self.inner.atomic_read(path)
    }
    fn atomic_write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        let result = self.inner.atomic_write(path, data);
        // A temporary reader that did not share DELETE can deny replacement on
        // Windows. Retry the whole atomic operation, never truncate the old file.
        // Permanent permission failures still return after at most 254 ms of waits.
        #[cfg(windows)]
        let result = {
            let mut result = result;
            let mut retries = 0;
            for delay in [2, 4, 8, 16, 32, 64, 64, 64] {
                if !result
                    .as_ref()
                    .is_err_and(|error| matches!(error.raw_os_error(), Some(5 | 32)))
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(delay));
                retries += 1;
                result = self.inner.atomic_write(path, data);
            }
            if result.is_ok() && retries > 0 && std::env::var_os("SECT_TIMING").is_some() {
                eprintln!(
                    "lexical atomic_write {} recovered after {retries} retries",
                    self.root.join(path).display()
                );
            }
            result
        };
        self.report("atomic_write", path, result)
    }
    fn sync_directory(&self) -> io::Result<()> {
        self.inner.sync_directory()
    }
    fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
        self.inner.acquire_lock(lock)
    }
    fn watch(&self, callback: WatchCallback) -> tantivy::Result<WatchHandle> {
        self.inner.watch(callback)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn atomic_metadata_replacement_recovers_from_a_reader_and_keeps_old_bytes_on_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = IndexDirectory::open(temporary.path()).unwrap();
        let path = Path::new(".managed.json");
        directory.atomic_write(path, b"old metadata").unwrap();
        let lock_reader = || {
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(temporary.path().join(path))
                .unwrap()
        };
        let lock = lock_reader();
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut lock = lock;
            let mut text = String::new();
            lock.read_to_string(&mut text).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(70));
            drop(lock);
            text
        });
        directory.atomic_write(path, b"new metadata").unwrap();
        assert_eq!(reader.join().unwrap(), "old metadata");
        assert_eq!(directory.atomic_read(path).unwrap(), b"new metadata");

        let lock = lock_reader();
        assert!(directory
            .atomic_write(path, b"must not be published")
            .is_err());
        assert_eq!(directory.atomic_read(path).unwrap(), b"new metadata");
        drop(lock);
    }
}
