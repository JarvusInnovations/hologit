//! holo-projector-napi: Node.js native binding for [holo-projector](../holo-projector).
//!
//! Exposes the Rust composition engine to the hologit CLI's hybrid dispatcher
//! (`lib/RustEngine.js`) per `specs/api/projector-napi.md`:
//!
//! ```text
//!   compositeBranch(gitDir, rootTree, holobranch)  // → pre-lens tree hash
//!   projectBranch(gitDir, rootTree, holobranch)    // → full composition-only projection
//!   projectPlan(gitDir, sources, mappings)         // → structured-config composition
//! ```
//!
//! Conventions across the FFI boundary (matching holo-tree-napi):
//! - **Object ids** cross as lowercase hex `String`; `rootTree` accepts a
//!   tree hash or a commit/tag hash (peeled to its tree).
//! - **Errors** cross as JS `Error`s whose `code` property carries the stable
//!   code from `specs/api/projector-napi.md` (`holo_projector::Error::code()`,
//!   plus binding-level `INVALID_ARGUMENT`/`GIT`/`PANIC`). Consumers match on
//!   `err.code`, never on message prose.
//! - **Panics never cross.** Every export is wrapped in [`contained`] (with
//!   `#[napi(catch_unwind)]` as a backstop for marshalling code), so a Rust
//!   panic surfaces as a catchable JS error with code `PANIC` instead of
//!   unwinding through the `extern "C"` trampoline and aborting the host —
//!   the failure mode `specs/api/errors.md` § Panic policy exists to prevent.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use holo_projector::error::Error as ProjectorError;
use holo_projector::{PlanMapping, PlanSource};

type ObjectId = gix::ObjectId;

// ── error plumbing ──────────────────────────────────────────────────────────

/// Stable error code carried to JS as the thrown error's `code` property.
///
/// napi sets a thrown error's `code` from its status string; using the
/// projector code as the status is what lets the dispatcher branch on cause
/// (`err.code === 'SOURCE_RESOLUTION'` → fall back and let JS fetch) instead
/// of parsing prose. Codes are specced in `specs/api/projector-napi.md`.
#[derive(Debug, Clone, Copy)]
pub struct ErrorCode(pub &'static str);

impl AsRef<str> for ErrorCode {
    fn as_ref(&self) -> &str {
        self.0
    }
}

/// A `Result` whose error carries a stable projector error code.
type CodedResult<T> = std::result::Result<T, napi::Error<ErrorCode>>;

/// Map a holo-projector error into a JS exception carrying its stable code.
fn hp_err(e: ProjectorError) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode(e.code()), e.to_string())
}

/// A binding-level caller error (bad hex id, wrong object kind, …).
fn invalid_arg(message: impl ToString) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode("INVALID_ARGUMENT"), message.to_string())
}

/// A binding-level git failure that the projector doesn't classify further.
fn git_err(message: impl ToString) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode("GIT"), message.to_string())
}

/// Run `f`, converting any Rust panic into a catchable JS error with code
/// `PANIC` instead of letting it unwind across the FFI boundary.
///
/// Per `specs/api/errors.md` § Panic policy. `AssertUnwindSafe` is sound here
/// because after a `PANIC` error the involved objects are contractually in an
/// unspecified (memory-safe) state and must be discarded by the consumer —
/// and this binding holds no state across calls anyway.
fn contained<T>(f: impl FnOnce() -> CodedResult<T>) -> CodedResult<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|payload| {
        let message = if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else {
            "unknown panic payload".to_string()
        };
        Err(napi::Error::new(
            ErrorCode("PANIC"),
            format!("panic in holo-projector binding (this is a bug — please report): {message}"),
        ))
    })
}

/// Internal self-test hook: deliberately panics inside the binding so the
/// test suite can prove that a panic surfaces as a catchable JS error with
/// code `PANIC` rather than aborting the host process. Never call this
/// outside tests.
#[napi(js_name = "__triggerPanicForTest", catch_unwind)]
pub fn trigger_panic_for_test() -> Result<(), ErrorCode> {
    contained(|| panic!("deliberate panic-containment self-test"))
}

// ── repo/object helpers ─────────────────────────────────────────────────────

fn open_repo(git_dir: &str) -> CodedResult<gix::Repository> {
    gix::open(git_dir).map_err(|e| git_err(format!("failed to open repo at '{git_dir}': {e}")))
}

fn parse_oid(hex: &str) -> CodedResult<ObjectId> {
    ObjectId::from_hex(hex.as_bytes())
        .map_err(|e| invalid_arg(format!("invalid object id '{hex}': {e}")))
}

/// Resolve `rootTree` to a tree id: a tree hash passes through; a commit or
/// tag hash is peeled to its tree.
fn peel_to_tree(repo: &gix::Repository, hex: &str) -> CodedResult<ObjectId> {
    let id = parse_oid(hex)?;
    let mut obj = repo
        .find_object(id)
        .map_err(|e| git_err(format!("object {hex} not found: {e}")))?;

    loop {
        match obj.kind {
            gix::object::Kind::Tree => return Ok(obj.id().detach()),
            gix::object::Kind::Commit => {
                let commit = obj
                    .try_into_commit()
                    .map_err(|e| git_err(format!("{hex} failed to parse as commit: {e}")))?;
                let tree_id = commit
                    .tree_id()
                    .map_err(|e| git_err(format!("{hex} has no tree: {e}")))?
                    .detach();
                return Ok(tree_id);
            }
            gix::object::Kind::Tag => {
                let tag = obj
                    .try_into_tag()
                    .map_err(|e| git_err(format!("{hex} failed to parse as tag: {e}")))?;
                let target = tag
                    .target_id()
                    .map_err(|e| git_err(format!("{hex} tag has no target: {e}")))?
                    .detach();
                obj = repo
                    .find_object(target)
                    .map_err(|e| git_err(format!("tag target of {hex} not found: {e}")))?;
            }
            gix::object::Kind::Blob => {
                return Err(invalid_arg(format!(
                    "object {hex} is a blob; expected a tree, commit, or tag"
                )))
            }
        }
    }
}

fn oid_hex(oid: ObjectId) -> String {
    oid.to_hex().to_string()
}

// ── projection entry points ─────────────────────────────────────────────────

/// Compose a holobranch to its **pre-lens tree**: the extends chain and all
/// mappings composed per `specs/behaviors/composition.md`, with
/// `.holo/{branches,sources}` stripped but the final `.holo` strip skipped so
/// the host's lens phase can discover `.holo/lenses` and `.holo/config.toml`.
/// Returns the composed tree hash.
#[napi(catch_unwind)]
pub fn composite_branch(
    git_dir: String,
    root_tree: String,
    holobranch: String,
) -> Result<String, ErrorCode> {
    contained(|| {
        let repo = open_repo(&git_dir)?;
        let tree_id = peel_to_tree(&repo, &root_tree)?;
        let out = holo_projector::composite_branch(&repo, tree_id, &holobranch).map_err(hp_err)?;
        Ok(oid_hex(out))
    })
}

/// Full composition-only projection of a holobranch, including the final
/// metadata strip — hash-equal to the legacy engine with lensing disabled.
/// Returns the projected tree hash.
#[napi(catch_unwind)]
pub fn project_branch(
    git_dir: String,
    root_tree: String,
    holobranch: String,
) -> Result<String, ErrorCode> {
    contained(|| {
        let repo = open_repo(&git_dir)?;
        let tree_id = peel_to_tree(&repo, &root_tree)?;
        let out = holo_projector::project_branch(&repo, tree_id, &holobranch).map_err(hp_err)?;
        Ok(oid_hex(out))
    })
}

/// A source definition for `projectPlan`. Mirrors `ProjectionPlan.addSource`.
#[napi(object)]
pub struct JsPlanSource {
    pub name: String,
    pub url: Option<String>,
    #[napi(js_name = "ref")]
    pub git_ref: Option<String>,
    pub project_holobranch: Option<String>,
}

/// A mapping definition for `projectPlan`. Mirrors `ProjectionPlan.addMapping`
/// defaults: `files` `["**"]`, `root`/`output` `"."`, `layer` = source name.
#[napi(object)]
pub struct JsPlanMapping {
    pub source: String,
    pub files: Option<Vec<String>>,
    pub root: Option<String>,
    pub output: Option<String>,
    pub layer: Option<String>,
    pub after: Option<Vec<String>>,
    pub before: Option<Vec<String>>,
}

/// Compose git trees from structured source/mapping definitions — the
/// `ProjectionPlan` path, no `.holo/` config needed. Returns the composed
/// tree hash (full projection, metadata stripped).
#[napi(catch_unwind)]
pub fn project_plan(
    git_dir: String,
    sources: Vec<JsPlanSource>,
    mappings: Vec<JsPlanMapping>,
) -> Result<String, ErrorCode> {
    contained(|| {
        let repo = open_repo(&git_dir)?;

        let plan_sources: Vec<PlanSource> = sources
            .into_iter()
            .map(|s| PlanSource {
                name: s.name,
                url: s.url,
                git_ref: s.git_ref,
                project_holobranch: s.project_holobranch,
            })
            .collect();

        let plan_mappings: Vec<PlanMapping> = mappings
            .into_iter()
            .map(|m| {
                let mut mapping = PlanMapping::new(&m.source);
                if let Some(files) = m.files {
                    mapping.files = files;
                }
                if let Some(root) = m.root {
                    mapping.root = root;
                }
                if let Some(output) = m.output {
                    mapping.output = output;
                }
                if let Some(layer) = m.layer {
                    mapping.layer = layer;
                }
                if let Some(after) = m.after {
                    mapping.after = after;
                }
                if let Some(before) = m.before {
                    mapping.before = before;
                }
                mapping
            })
            .collect();

        let out =
            holo_projector::project_plan(&repo, &plan_sources, &plan_mappings).map_err(hp_err)?;
        Ok(oid_hex(out))
    })
}

// ── stats ───────────────────────────────────────────────────────────────────

/// Engine performance counters — process-global, monotonic, metrics only.
#[napi(object)]
pub struct Stats {
    pub trees_read: f64,
    pub trees_written: f64,
    pub trees_skipped_clean: f64,
    pub cache_hits: f64,
    pub cache_misses: f64,
    pub blobs_read: f64,
}

/// Current engine performance counters.
#[napi(catch_unwind)]
pub fn stats() -> Stats {
    let s = holo_projector::stats();
    Stats {
        trees_read: s.trees_read as f64,
        trees_written: s.trees_written as f64,
        trees_skipped_clean: s.trees_skipped_clean as f64,
        cache_hits: s.cache_hits as f64,
        cache_misses: s.cache_misses as f64,
        blobs_read: s.blobs_read as f64,
    }
}

/// Reset engine counters and module-level caches.
#[napi(catch_unwind)]
pub fn reset_stats() {
    holo_projector::reset();
}
