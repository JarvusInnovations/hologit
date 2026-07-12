//! holo-projector: Holobranch projection engine.
//!
//! Composes git trees from multiple sources according to declarative
//! `.holo/` configuration or structured input. Built on [`holo_tree`]
//! for git object access.
//!
//! # Entry points
//!
//! - [`project_branch`] — TOML-driven: reads `.holo/` config from a git tree
//! - [`project_plan`] — Programmatic: accepts structured source/mapping definitions
//! - [`commit_projection`] — Edge capability: commit a composed tree and advance a ref

pub mod branch;
pub mod commit;
pub mod config;
pub mod error;
pub mod fetch;
pub mod projection;
pub mod source;

use error::Result;
use gix::ObjectId;

// Re-export holo-tree for consumers that need the tree primitives
pub use holo_tree;

// Projection-commit creation (specs/behaviors/projection-commits.md):
// the side-effecting edge capability layered on pure composition.
pub use commit::{commit_projection, CommitProjectionOptions, ProjectionSource};

// Remote source fetching (specs/behaviors/source-resolution.md): the edge
// capability that populates refs/holo/source/... for the *_fetching entries.
pub use fetch::{FetchKind, GitCliFetcher, SourceFetcher};

// ── Public API ─────────────────────────────────────────────────────────────

/// Project a holobranch by reading `.holo/` config from a git tree.
pub fn project_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    projection::project_branch(repo, root_tree_id, branch_name)
}

/// [`project_branch`] with remote source fetching enabled: sources that
/// don't resolve locally are fetched into `refs/holo/source/...` through
/// `fetcher` and resolution retried (`specs/behaviors/source-resolution.md`).
pub fn project_branch_fetching(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
    fetcher: &dyn SourceFetcher,
) -> Result<ObjectId> {
    let cache = holo_tree::TreeCache::new();
    let ctx = holo_tree::Context::new(repo, &cache);
    projection::project_branch_fetching_in(&ctx, root_tree_id, branch_name, fetcher)
}

/// [`composite_branch`] with remote source fetching enabled (see
/// [`project_branch_fetching`]).
pub fn composite_branch_fetching(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
    fetcher: &dyn SourceFetcher,
) -> Result<ObjectId> {
    let cache = holo_tree::TreeCache::new();
    let ctx = holo_tree::Context::new(repo, &cache);
    projection::composite_branch_fetching_in(&ctx, root_tree_id, branch_name, fetcher)
}

/// Compose a holobranch to its **pre-lens tree**: mappings composed and
/// `.holo/{branches,sources}` stripped, but the final `.holo` strip skipped
/// so a host-driven lens phase can run on the result. This is the hybrid
/// CLI's composition seam (`specs/behaviors/engine-selection.md`).
pub fn composite_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    projection::composite_branch(repo, root_tree_id, branch_name)
}

/// Compose git trees from structured source/mapping definitions.
pub fn project_plan(
    repo: &gix::Repository,
    sources: &[PlanSource],
    mappings: &[PlanMapping],
) -> Result<ObjectId> {
    projection::project_plan(repo, sources, mappings)
}

/// Reset all module-level caches and stats counters.
pub fn reset() {
    holo_tree::reset();
}

/// Return current performance statistics.
pub fn stats() -> holo_tree::tree::Stats {
    holo_tree::stats()
}

// ── Plan builder types ─────────────────────────────────────────────────────

/// A source definition for the plan builder API.
#[derive(Debug, Clone)]
pub struct PlanSource {
    pub name: String,
    pub url: Option<String>,
    pub git_ref: Option<String>,
    pub project_holobranch: Option<String>,
}

/// A mapping definition for the plan builder API.
#[derive(Debug, Clone)]
pub struct PlanMapping {
    pub source: String,
    pub files: Vec<String>,
    pub root: String,
    pub output: String,
    pub layer: String,
    pub after: Vec<String>,
    pub before: Vec<String>,
}

impl PlanMapping {
    /// Create a mapping with sensible defaults (all files, root output).
    pub fn new(source: &str) -> Self {
        PlanMapping {
            source: source.to_string(),
            files: vec!["**".to_string()],
            root: ".".to_string(),
            output: ".".to_string(),
            layer: source.to_string(),
            after: vec![],
            before: vec![],
        }
    }
}
