//! holo-projector-napi: Node.js native binding for [holo-projector](../holo-projector).
//!
//! Exposes the Rust composition engine to the hologit CLI's hybrid dispatcher
//! (`lib/RustEngine.js`) per `specs/api/projector-napi.md`:
//!
//! ```text
//!   compositeBranch(gitDir, rootTree, holobranch)  // → pre-lens tree hash
//!   projectBranch(gitDir, rootTree, holobranch)    // → full composition-only projection
//!   projectPlan(gitDir, sources, mappings)         // → structured-config composition
//!   new ProjectionSession(gitDir)                  // → warm context for repeat projections
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
use holo_projector::{
    CommitProjectionOptions as EngineCommitOptions, PlanMapping, PlanSource, ProjectionSource,
};
use holo_projector::holo_tree::{Context, TreeCache};

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
/// including a [`ProjectionSession`], the one object that holds state across
/// calls.
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

/// gix object cache size applied to the repository handle each entry point
/// opens.
///
/// gix leaves the object cache at size 0 unless set; without it, a projection
/// re-decodes objects it touches repeatedly (config blobs, shared subtrees
/// across mappings and recursive sub-projections). 16 MiB follows gix's own
/// sizing guidance and mirrors holo-tree-napi's `OBJECT_CACHE_BYTES`.
///
/// The top-level entry points are one-shot: one call opens one handle, runs
/// one whole projection (thousands of object reads), and drops it. Hosts
/// making repeat projections hold a [`ProjectionSession`] instead, whose
/// memoized thread-local handle (see [`local_repo`]) keeps this cache warm
/// across calls.
const OBJECT_CACHE_BYTES: usize = 16 * 1024 * 1024;

fn open_repo(git_dir: &str) -> CodedResult<gix::Repository> {
    let mut repo = gix::open(git_dir)
        .map_err(|e| git_err(format!("failed to open repo at '{git_dir}': {e}")))?;
    repo.object_cache_size_if_unset(OBJECT_CACHE_BYTES);
    Ok(repo)
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

fn convert_plan_sources(sources: Vec<JsPlanSource>) -> Vec<PlanSource> {
    sources
        .into_iter()
        .map(|s| PlanSource {
            name: s.name,
            url: s.url,
            git_ref: s.git_ref,
            project_holobranch: s.project_holobranch,
        })
        .collect()
}

fn convert_plan_mappings(mappings: Vec<JsPlanMapping>) -> Vec<PlanMapping> {
    mappings
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
        .collect()
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
        let plan_sources = convert_plan_sources(sources);
        let plan_mappings = convert_plan_mappings(mappings);
        let out =
            holo_projector::project_plan(&repo, &plan_sources, &plan_mappings).map_err(hp_err)?;
        Ok(oid_hex(out))
    })
}

// ── warm projection session ─────────────────────────────────────────────────

/// A `gix::Repository` derived on — and only ever *used* on — one thread
/// (the holo-tree-napi `local_repo` pattern, PR #491).
struct ThreadLocalRepo {
    thread: std::thread::ThreadId,
    repo: gix::Repository,
}

// The memoized handle may be *moved* between threads with its owning object
// (napi may finalize on another thread), which requires `gix::Repository:
// Send`. Usage stays confined to the recorded thread via `local_repo`.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<gix::Repository>();
};

fn derive_local(shared: &gix::ThreadSafeRepository) -> ThreadLocalRepo {
    let mut repo = shared.to_thread_local();
    repo.object_cache_size_if_unset(OBJECT_CACHE_BYTES);
    ThreadLocalRepo {
        thread: std::thread::current().id(),
        repo,
    }
}

/// Reuse the memoized thread-local `gix::Repository`, re-deriving when a call
/// lands on a different thread than the memo. Sound per `specs/api/errors.md`
/// § Thread-safety expectations: a thread switch costs at most warmth (a
/// re-derivation and a cold object cache), never a behavioral difference.
fn local_repo<'a>(
    slot: &'a mut Option<ThreadLocalRepo>,
    shared: &gix::ThreadSafeRepository,
) -> &'a gix::Repository {
    let tid = std::thread::current().id();
    if !matches!(slot, Some(memo) if memo.thread == tid) {
        *slot = None; // discard a handle derived on another thread
    }
    &slot.get_or_insert_with(|| derive_local(shared)).repo
}

/// A commit identity (author or committer). `timeSeconds`/`offsetMinutes`
/// are optional; when omitted the current wall-clock time at UTC is used.
/// Pass them explicitly to reproduce a specific commit byte-for-byte.
#[napi(object)]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub time_seconds: Option<i64>,
    pub offset_minutes: Option<i32>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Render git's `"<seconds> ±HHMM"` signature-time format.
fn format_git_time(seconds: i64, offset_minutes: i32) -> String {
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let abs = offset_minutes.unsigned_abs();
    format!("{seconds} {sign}{:02}{:02}", abs / 60, abs % 60)
}

fn to_gix_signature(sig: Signature) -> CodedResult<gix::actor::Signature> {
    let seconds = sig.time_seconds.unwrap_or_else(now_secs);
    let time = format_git_time(seconds, sig.offset_minutes.unwrap_or(0));
    gix::actor::SignatureRef {
        name: sig.name.as_str().into(),
        email: sig.email.as_str().into(),
        time: &time,
    }
    .to_owned()
    .map_err(|e| invalid_arg(format!("invalid signature time: {e}")))
}

/// Options for [`ProjectionSession::commit_projection`]
/// (`specs/behaviors/projection-commits.md`). Exactly one of
/// `sourceDescription` (ref mode) / `workTreePath` (working-tree mode) is
/// required — the provenance string is host-computed, never engine-derived.
#[napi(object)]
pub struct CommitProjectionOptions {
    /// Target ref to advance (the oracle's `commitTo`); normalized by the
    /// engine (`HEAD` and `refs/...` pass through, else `refs/heads/<name>`).
    pub commit_ref: String,
    /// The projected holobranch's name.
    pub holobranch: String,
    /// The composed output tree to commit (tree hash, or a commit/tag hash
    /// peeled to its tree).
    pub tree: String,
    /// The source commit the projection was taken from; second parent when
    /// present.
    pub source_commit: Option<String>,
    /// Ref-mode provenance: the host's `git describe --always --tags` output.
    pub source_description: Option<String>,
    /// Working-tree-mode provenance: the absolute work-tree path.
    pub work_tree_path: Option<String>,
    /// Message override — replaces the entire default message, trailers
    /// included (oracle quirk, ported).
    pub message: Option<String>,
    /// Explicit author; omitted, identity resolves from repo config
    /// (including `GIT_AUTHOR_*` env), then holo-tree's fallback.
    pub author: Option<Signature>,
    /// Explicit committer; same fallback chain as `author`.
    pub committer: Option<Signature>,
}

/// Warm engine context for repeat projections (`specs/api/projector-napi.md`
/// § ProjectionSession): a persistent repository handle plus one consumer-
/// owned [`TreeCache`] reused across calls.
///
/// Staleness contract: only content-addressed state is cached (parsed trees
/// keyed by tree id, the gix object cache keyed by object id) — immutable by
/// construction. Refs are re-resolved from the repository on every call, and
/// objects written behind the session (new loose objects/packs) are found
/// without reopening it: gix stats loose refs and revalidates its packed-refs
/// snapshot per access, and refreshes its pack list on an object miss. The
/// session test suite proves both by writing refs/objects behind an open
/// session.
#[napi]
pub struct ProjectionSession {
    repo: gix::ThreadSafeRepository,
    local: Option<ThreadLocalRepo>,
    cache: TreeCache,
}

#[napi]
impl ProjectionSession {
    /// Open a repository at `gitDir` (a `.git` directory, or any path gix can
    /// discover a repo from) and bind a fresh `TreeCache` to it.
    #[napi(constructor)]
    pub fn new(git_dir: String) -> Result<ProjectionSession, ErrorCode> {
        contained(|| {
            let repo = gix::open(&git_dir)
                .map_err(|e| git_err(format!("failed to open repo at '{git_dir}': {e}")))?
                .into_sync();
            Ok(ProjectionSession {
                repo,
                local: None,
                cache: TreeCache::new(),
            })
        })
    }

    /// [`composite_branch`] against this session's warm context.
    #[napi(catch_unwind)]
    pub fn composite_branch(
        &mut self,
        root_tree: String,
        holobranch: String,
    ) -> Result<String, ErrorCode> {
        let ProjectionSession { repo, local, cache } = self;
        contained(|| {
            let repo = local_repo(local, repo);
            let tree_id = peel_to_tree(repo, &root_tree)?;
            let ctx = Context::new(repo, cache);
            let out = holo_projector::composite_branch_in(&ctx, tree_id, &holobranch)
                .map_err(hp_err)?;
            Ok(oid_hex(out))
        })
    }

    /// [`project_branch`] against this session's warm context.
    #[napi(catch_unwind)]
    pub fn project_branch(
        &mut self,
        root_tree: String,
        holobranch: String,
    ) -> Result<String, ErrorCode> {
        let ProjectionSession { repo, local, cache } = self;
        contained(|| {
            let repo = local_repo(local, repo);
            let tree_id = peel_to_tree(repo, &root_tree)?;
            let ctx = Context::new(repo, cache);
            let out =
                holo_projector::project_branch_in(&ctx, tree_id, &holobranch).map_err(hp_err)?;
            Ok(oid_hex(out))
        })
    }

    /// [`project_plan`] against this session's warm context.
    #[napi(catch_unwind)]
    pub fn project_plan(
        &mut self,
        sources: Vec<JsPlanSource>,
        mappings: Vec<JsPlanMapping>,
    ) -> Result<String, ErrorCode> {
        let ProjectionSession { repo, local, cache } = self;
        contained(|| {
            let repo = local_repo(local, repo);
            let ctx = Context::new(repo, cache);
            let plan_sources = convert_plan_sources(sources);
            let plan_mappings = convert_plan_mappings(mappings);
            let out = holo_projector::project_plan_in(&ctx, &plan_sources, &plan_mappings)
                .map_err(hp_err)?;
            Ok(oid_hex(out))
        })
    }

    /// Create a projection commit for a composed tree and advance the target
    /// ref (`specs/behaviors/projection-commits.md`). Returns the new commit
    /// id; a concurrent ref move surfaces as `REF_CONFLICT`.
    #[napi(catch_unwind)]
    pub fn commit_projection(
        &mut self,
        options: CommitProjectionOptions,
    ) -> Result<String, ErrorCode> {
        let ProjectionSession { repo, local, .. } = self;
        contained(|| {
            let repo = local_repo(local, repo);

            let source = match (&options.source_description, &options.work_tree_path) {
                (Some(description), None) => ProjectionSource::Described { description },
                (None, Some(path)) => ProjectionSource::WorkTree { path },
                _ => {
                    return Err(invalid_arg(
                        "exactly one of sourceDescription or workTreePath is required",
                    ))
                }
            };

            let tree = peel_to_tree(repo, &options.tree)?;
            let source_commit = options
                .source_commit
                .as_deref()
                .map(parse_oid)
                .transpose()?;
            let author = options.author.map(to_gix_signature).transpose()?;
            let committer = options.committer.map(to_gix_signature).transpose()?;

            let commit = holo_projector::commit_projection(
                repo,
                EngineCommitOptions {
                    commit_ref: &options.commit_ref,
                    holobranch: &options.holobranch,
                    tree,
                    source_commit,
                    source,
                    message: options.message.as_deref(),
                    author,
                    committer,
                },
            )
            .map_err(hp_err)?;

            Ok(oid_hex(commit))
        })
    }

    /// Number of trees held in this session's `TreeCache` — observability so
    /// warmth is provable in tests; metrics only, never an input to behavior.
    #[napi(catch_unwind)]
    pub fn cached_trees(&self) -> u32 {
        self.cache.len() as u32
    }

    /// Drop the session's `TreeCache`. Never required for correctness —
    /// content-addressed entries cannot go stale — this is a memory valve for
    /// long-lived hosts.
    #[napi(catch_unwind)]
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
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
