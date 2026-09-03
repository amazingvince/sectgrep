//! Corpus layer: walk the tree, parse section files into [`Document`]s, fingerprint them, and
//! check the spec B.2 contract. Deterministic; no model is involved anywhere here.

pub mod document;
pub mod fingerprint;
pub mod validate;
pub mod walk;

pub use document::{parse_document, slug, split_front_matter, Document, Link};
pub use fingerprint::{fingerprint_file, stat_file, Fingerprint};
pub use validate::{validate, Issue, Level};
pub use walk::{load_sources, walk_corpus, CorpusFile};
