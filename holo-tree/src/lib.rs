//! holo-tree: Mutable in-memory git trees via gix.
//!
//! Read, navigate, merge, and write git trees directly through gix's
//! packfile and loose object layer — no git subprocess needed.
//!
//! This crate provides the shared tree primitive used by both
//! [holo-projector](https://github.com/JarvusInnovations/hologit) (holobranch projection)
//! and gitsheets (record-oriented git storage).
//!
//! # Core type
//!
//! [`MutableTree`] is an in-memory git tree node with lazy-loaded children,
//! dirty tracking, and three merge modes (overlay, replace, underlay).
//!
//! # Modules
//!
//! - [`tree`] — MutableTree, Child, merge, write, cache
//! - [`glob`] — Minimatch-compatible glob matching
//! - [`toml`] — Generic TOML-from-git-blob reader
//! - [`repo`] — Ref resolution, commit creation, ref updates

pub mod error;
pub mod glob;
pub mod repo;
pub mod toml;
pub mod tree;

// Re-export the most-used types at crate root
pub use error::{Error, Result};
pub use gix::ObjectId;
pub use tree::{BlobInfo, Child, MergeMode, MergeOptions, MutableTree};

/// Reset all module-level caches and stats counters.
pub fn reset() {
    tree::reset();
}

/// Return current performance statistics.
pub fn stats() -> tree::Stats {
    tree::stats()
}
