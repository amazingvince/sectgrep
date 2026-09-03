//! Structural layer (spec B.4 "Structural"): built from front matter and the markdown AST by
//! deterministic traversal, never by a model. `tree.json` (milestone 1); `xrefs.jsonl`,
//! `actions.jsonl`, `terms.json`, `tables.jsonl`, and the traversal verbs (milestone 2).

pub mod graph;
pub mod tree;
pub mod verbs;

pub use graph::{build_graph, ActionRec, Edge, Graph, TableRec, TermRec, Usage, EDGE_TYPES};
pub use tree::{build_tree, ExprInfo, Node, Tree};
pub use verbs::{history, map_complete, refs, Direction, HistoryEntry, MapItem, RefHit};
