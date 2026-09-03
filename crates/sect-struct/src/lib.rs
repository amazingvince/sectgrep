//! Structural layer (spec B.4 "Structural"): built from front matter and markdown by
//! deterministic traversal, never by a model. Milestone 1 ships the tree; milestone 2 adds
//! `xrefs.jsonl`, `actions.jsonl`, `terms.json`, `tables.jsonl`, and as-of snapping.

pub mod tree;

pub use tree::{build_tree, ExprInfo, Node, Tree};
