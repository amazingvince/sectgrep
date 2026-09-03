use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum SectError {
    #[error("{path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path}: missing front matter (file must start with a `---` block)")]
    MissingFrontMatter { path: PathBuf },
    #[error("{path}: front matter: {message}")]
    FrontMatter { path: PathBuf, message: String },
    #[error("{0} is not a corpus root: no `_source.yaml` in any direct subdirectory")]
    NotACorpus(PathBuf),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("validation failed with {0} error(s)")]
    Validation(usize),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl SectError {
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        SectError::Io { path: path.into(), source }
    }
}

pub type Result<T> = std::result::Result<T, SectError>;
