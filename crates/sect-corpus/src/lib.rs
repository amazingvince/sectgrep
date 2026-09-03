//! Corpus layer: walk the tree, parse section files into [`Document`]s (front matter, comrak
//! AST for links and tables, regex fallback for prose citations), fingerprint them, and check
//! the spec B.2 contract. Deterministic; no model is involved anywhere here.

pub mod cite;
pub mod document;
pub mod fingerprint;
pub mod validate;
pub mod walk;

pub use cite::{Citation, Resolver};
pub use document::{parse_document, slug, split_front_matter, AnchorLine, Definition, Document, Link, Table, Via};
pub use fingerprint::{fingerprint_file, stat_file, Fingerprint};
pub use validate::{validate, Issue, Level};
pub use walk::{load_sources, walk_corpus, CorpusFile};
