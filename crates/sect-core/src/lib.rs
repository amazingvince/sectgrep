//! Core types shared by every `sect` crate: identifiers, front matter (spec B.2), source
//! configuration (`_source.yaml`), the error type, and the response header that every verb
//! prints first (a freshness line and a counts line, spec B.1 and B.3).

pub mod error;
pub mod front;
pub mod ids;
pub mod response;
pub mod source;

pub use error::{Result, SectError};
pub use front::{Action, FrontMatter, Narrow, NoteSource, Provenance};
pub use ids::{expr_id, split_expr};
pub use response::{Counts, Freshness, Header, Response};
pub use source::SourceConfig;

/// Version of the on-disk index layout under `.sect/`.
pub const SCHEMA_VERSION: u32 = 1;
/// Index directory name inside the corpus root (spec B.5).
pub const INDEX_DIR: &str = ".sect";
/// Per-source configuration file name (spec B.2).
pub const SOURCE_FILE: &str = "_source.yaml";
/// Binary version, from the workspace.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
