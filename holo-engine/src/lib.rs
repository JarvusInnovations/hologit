//! holo-engine: Git tree composition engine.
//!
//! The performance-critical core of hologit. Composes git trees from
//! multiple sources according to declarative configuration, using gix
//! for direct packfile access (no git subprocess).
//!
//! # Entry points
//!
//! - [`project_branch`] — TOML-driven: reads `.holo/` config from a git tree
//! - [`project_plan`] — Programmatic: accepts structured source/mapping definitions
//!
//! Both share the same composition internals (toposort, source resolution,
//! tree merge, ODB write-back).

pub mod branch;
pub mod config;
pub mod error;
pub mod glob;
pub mod projection;
pub mod source;
pub mod tree;

use error::Result;
use gix::ObjectId;

// ── Public API ─────────────────────────────────────────────────────────────

/// Project a holobranch by reading `.holo/` config from a git tree.
///
/// This is the path used by `git holo project`. It discovers workspace
/// config, branches, sources, and mappings from the tree, resolves the
/// branch's `extend` chain, composes all mappings, strips metadata,
/// and returns the final tree hash.
pub fn project_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    projection::project_branch(repo, root_tree_id, branch_name)
}

/// Compose git trees from structured source/mapping definitions.
///
/// This is the path used by `ProjectionPlan`. No `.holo/` directory
/// is needed in the source repositories — config is passed directly.
pub fn project_plan(
    repo: &gix::Repository,
    sources: &[PlanSource],
    mappings: &[PlanMapping],
) -> Result<ObjectId> {
    projection::project_plan(repo, sources, mappings)
}

/// Reset all module-level caches and stats counters.
pub fn reset() {
    tree::reset();
}

/// Return current performance statistics.
pub fn stats() -> tree::Stats {
    tree::stats()
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
