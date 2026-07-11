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
//! - [`tree`] — MutableTree, Child, merge, write, TreeCache/Context
//! - [`glob`] — Minimatch-compatible glob matching
//! - [`toml`] — Generic TOML-from-git-blob reader
//! - [`repo`] — Ref resolution, commit creation, ref updates

// Panic policy (specs/api/errors.md): no panicking constructs reachable from
// public entry points — violated invariants degrade to Error::Internal.
// Unit-test modules are exempt (tests may unwrap).
#![cfg_attr(
    not(test),
    warn(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::indexing_slicing,
        clippy::panic,
        clippy::unreachable
    )
)]

pub mod error;
pub mod glob;
pub mod repo;
pub mod toml;
pub mod tree;

// Re-export the most-used types at crate root
pub use error::{Error, Result};
pub use gix::ObjectId;
pub use tree::{BlobInfo, Child, Context, MergeMode, MergeOptions, MutableTree, TreeCache};

/// Reset all stats counters. Tree caches are consumer-owned ([`TreeCache`]) —
/// drop or clear them directly.
pub fn reset() {
    tree::reset();
}

/// Return current performance statistics.
pub fn stats() -> tree::Stats {
    tree::stats()
}
