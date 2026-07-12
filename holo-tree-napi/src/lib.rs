//! holo-tree-napi: Node.js native binding for [holo-tree](../holo-tree).
//!
//! Exposes the narrow slice of holo-tree's `MutableTree` + `repo` helpers that
//! gitsheets needs for its upsert→commit path:
//!
//! ```text
//!   const repo = Repo.open(gitDir)
//!   const tree = repo.createTreeFromRef('HEAD')   // or repo.createTree()
//!   tree.writeChild(path, content)                // hash blob + deep insert
//!   const treeHash   = tree.write()               // flush dirty subtrees → ODB
//!   const commitHash = repo.commitTree(treeHash, [parentHash], message)
//!   repo.updateRef(refname, commitHash)
//! ```
//!
//! Conventions across the FFI boundary:
//! - **Object ids** cross as lowercase hex `String` (matches gitsheets' existing
//!   hash handling — it stores/compares hashes as hex strings everywhere).
//! - **Blob content** crosses as `Buffer` (binary-safe; records are TOML/text
//!   but attachments are arbitrary bytes).
//! - **Errors** cross as JS `Error`s whose `code` property carries the stable
//!   code from `specs/api/errors.md` (`holo_tree::Error::code()`, plus the
//!   binding-level `INVALID_ARGUMENT`/`GIT`/`PANIC`). Consumers match on
//!   `err.code`, never on message prose.
//! - **Panics never cross.** Every export is wrapped in [`contained`] (and
//!   `#[napi(catch_unwind)]` as a backstop for marshalling code), so a Rust
//!   panic surfaces as a catchable JS error with code `PANIC` instead of
//!   unwinding through the `extern "C"` trampoline — which aborts the whole
//!   host process (`fatal runtime error: failed to initiate panic`, gitsheets
//!   finding #6).
//!
//! This binding is a deliberately thin pass-through. Per the spike's governing
//! principle (see `plans/holo-tree-napi-spike.md` in gitsheets), rough edges in
//! holo-tree's API are fixed upstream — not papered over with cleverness here.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use holo_tree::repo as ht_repo;
use holo_tree::tree::empty_tree_id;
use holo_tree::{Context, MutableTree, ObjectId, TreeCache};

// ── error plumbing ──────────────────────────────────────────────────────────

/// Stable error code carried to JS as the thrown error's `code` property.
///
/// napi sets a thrown error's `code` from its status string; using the
/// holo-tree code as the status is what lets consumers branch on cause
/// (`err.code === 'REF_CONFLICT'`) instead of parsing prose — the fix for
/// gitsheets finding #4. Codes are specced in `specs/api/errors.md`.
#[derive(Debug, Clone, Copy)]
pub struct ErrorCode(pub &'static str);

impl AsRef<str> for ErrorCode {
    fn as_ref(&self) -> &str {
        self.0
    }
}

/// A `Result` whose error carries a stable holo-tree error code.
type CodedResult<T> = std::result::Result<T, napi::Error<ErrorCode>>;

/// Map a holo-tree error into a JS exception carrying its stable code.
fn ht_err(e: holo_tree::Error) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode(e.code()), e.to_string())
}

/// A binding-level caller error (bad hex id, unknown merge mode, …).
fn invalid_arg(message: impl ToString) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode("INVALID_ARGUMENT"), message.to_string())
}

/// A binding-level git failure that holo-tree doesn't classify further.
fn git_err(message: impl ToString) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode("GIT"), message.to_string())
}

/// Run `f`, converting any Rust panic into a catchable JS error with code
/// `PANIC` instead of letting it unwind across the FFI boundary.
///
/// Per `specs/api/errors.md` § Panic policy: a panic that escapes the binding
/// aborts the host process (Rust cannot unwind through the generated
/// `extern "C"` trampoline), which is exactly how gitsheets finding #6 took
/// down a whole Node process. `AssertUnwindSafe` is sound here because after a
/// `PANIC` error the involved objects are contractually in an unspecified
/// (memory-safe) state and must be discarded by the consumer.
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
            format!("panic in holo-tree binding (this is a bug — please report): {message}"),
        ))
    })
}

fn parse_oid(hex: &str) -> CodedResult<ObjectId> {
    ObjectId::from_hex(hex.as_bytes()).map_err(|e| invalid_arg(format!("invalid object id '{hex}': {e}")))
}

fn oid_hex(oid: ObjectId) -> String {
    oid.to_hex().to_string()
}

/// Git's well-known empty-tree hash (`4b825dc6…`).
#[napi(catch_unwind)]
pub fn empty_tree_hash() -> String {
    oid_hex(empty_tree_id())
}

/// Internal self-test hook: deliberately panics inside the binding so the
/// test suite can prove that a panic surfaces as a catchable JS error with
/// code `PANIC` rather than aborting the host process (specs/api/errors.md
/// § Panic policy). Never call this outside tests.
#[napi(js_name = "__triggerPanicForTest", catch_unwind)]
pub fn trigger_panic_for_test() -> Result<(), ErrorCode> {
    contained(|| panic!("deliberate panic-containment self-test"))
}

/// A commit identity (author or committer). `timeSeconds`/`offsetMinutes` are
/// optional; when omitted the current wall-clock time at UTC is used. Pass them
/// explicitly to reproduce a specific commit (e.g. match `git commit-tree`
/// under pinned `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`).
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

// ── Repo ────────────────────────────────────────────────────────────────────

/// A handle to a git repository, backed by gix.
///
/// Stored as a `ThreadSafeRepository` so the handle is `Send + Sync` and can be
/// cheaply cloned into each `Tree`; every call derives a thread-local
/// `gix::Repository` via `to_thread_local()`.
#[napi]
pub struct Repo {
    inner: gix::ThreadSafeRepository,
}

#[napi]
impl Repo {
    /// Open a repository at `gitDir` (a `.git` directory, or any path gix can
    /// discover a repo from).
    #[napi(factory, catch_unwind)]
    pub fn open(git_dir: String) -> Result<Repo, ErrorCode> {
        contained(|| {
            let inner = gix::open(&git_dir)
                .map_err(|e| git_err(format!("failed to open repo at '{git_dir}': {e}")))?
                .into_sync();
            Ok(Repo { inner })
        })
    }

    /// Resolve a ref (branch, tag, or commit hash) to its tree and return a
    /// mutable, in-memory view of it.
    #[napi(catch_unwind)]
    pub fn create_tree_from_ref(&self, git_ref: String) -> Result<Tree, ErrorCode> {
        contained(|| {
            let local = self.inner.to_thread_local();
            let inner = ht_repo::create_tree_from_ref(&local, &git_ref).map_err(ht_err)?;
            Ok(Tree {
                repo: self.inner.clone(),
                cache: TreeCache::new(),
                inner,
            })
        })
    }

    /// Create a fresh empty, mutable in-memory tree rooted at this repo.
    #[napi(catch_unwind)]
    pub fn create_tree(&self) -> Tree {
        Tree {
            repo: self.inner.clone(),
            cache: TreeCache::new(),
            inner: MutableTree::empty(),
        }
    }

    /// Write a commit object pointing at `treeHash` with `parents`. `author`
    /// and `committer` are optional; each falls back to the repo's configured
    /// identity, then a "holo-tree" default. Returns the new commit hash.
    #[napi(catch_unwind)]
    pub fn commit_tree(
        &self,
        tree_hash: String,
        parents: Vec<String>,
        message: String,
        author: Option<Signature>,
        committer: Option<Signature>,
    ) -> Result<String, ErrorCode> {
        contained(|| {
            let local = self.inner.to_thread_local();
            let tree = parse_oid(&tree_hash)?;
            let parent_oids = parents
                .iter()
                .map(|p| parse_oid(p))
                .collect::<CodedResult<Vec<_>>>()?;
            let author = author.map(to_gix_signature).transpose()?;
            let committer = committer.map(to_gix_signature).transpose()?;
            let commit =
                ht_repo::commit_tree(&local, tree, &parent_oids, &message, author, committer)
                    .map_err(ht_err)?;
            Ok(oid_hex(commit))
        })
    }

    /// Point a ref at an object hash.
    ///
    /// When `expectedOldHash` is provided this is a **compare-and-swap**: the
    /// update only succeeds if the ref currently resolves to exactly that hash,
    /// so a concurrent writer who moved the ref makes the swap fail rather than
    /// silently clobbering their commit. A lost swap throws with code
    /// `REF_CONFLICT` — the matchable optimistic-concurrency signal. Omit
    /// `expectedOldHash` to force the ref (the prior unconditional behavior).
    #[napi(catch_unwind)]
    pub fn update_ref(
        &self,
        refname: String,
        hash: String,
        expected_old_hash: Option<String>,
    ) -> Result<(), ErrorCode> {
        contained(|| {
            let local = self.inner.to_thread_local();
            let oid = parse_oid(&hash)?;
            let expected = expected_old_hash.as_deref().map(parse_oid).transpose()?;
            ht_repo::update_ref(&local, &refname, oid, expected).map_err(ht_err)
        })
    }

    /// Resolve a ref / rev-spec (branch, tag, `HEAD`, hash, …) to its commit
    /// hash, peeling annotated tags. Returns `null` when the ref does not
    /// resolve — the natural "does this ref exist?" probe before a CAS
    /// `updateRef`.
    #[napi(catch_unwind)]
    pub fn resolve_ref(&self, git_ref: String) -> Result<Option<String>, ErrorCode> {
        contained(|| {
            let local = self.inner.to_thread_local();
            let oid = ht_repo::resolve_ref(&local, &git_ref).map_err(ht_err)?;
            Ok(oid.map(oid_hex))
        })
    }

    /// Hash raw bytes as a loose blob in the ODB and return its hash, without
    /// inserting it into any tree. Binary-safe.
    #[napi(catch_unwind)]
    pub fn write_blob(&self, content: Buffer) -> Result<String, ErrorCode> {
        contained(|| {
            let local = self.inner.to_thread_local();
            let oid = local
                .write_blob(content.as_ref())
                .map_err(git_err)?
                .detach();
            Ok(oid_hex(oid))
        })
    }
}

// ── Tree read-models ─────────────────────────────────────────────────────────

/// A child entry returned by read-only navigation. `type` is `"tree"`,
/// `"blob"`, or `"commit"`; `mode` is the git filemode as a number
/// (e.g. `33188` = `0o100644`, `16384` = `0o040000` for a tree).
#[napi(object)]
pub struct ChildInfo {
    pub r#type: String,
    pub hash: String,
    pub mode: u32,
}

/// A named child entry, returned by `getChildren`.
#[napi(object)]
pub struct NamedChildInfo {
    pub name: String,
    pub r#type: String,
    pub hash: String,
    pub mode: u32,
}

/// A blob entry in a flattened blob map, returned by `getBlobMap`. `path` is
/// relative to the navigated subtree.
#[napi(object)]
pub struct BlobEntry {
    pub path: String,
    pub hash: String,
    pub mode: u32,
}

/// Options for `Tree.merge`. `mode` is `"overlay"`, `"replace"`, or
/// `"underlay"`; `files` is an optional list of glob patterns restricting which
/// paths merge (omit to merge everything).
#[napi(object)]
pub struct MergeOpts {
    pub files: Option<Vec<String>>,
    pub mode: String,
}

/// Classify a holo-tree `Child` into `(type, hash, mode)` for the read-models.
///
/// Note: for a `Tree` child the reported `hash` is the child's *stored* tree
/// hash, which is stale if that subtree has been mutated but not yet
/// `write()`-flushed. Read-only navigation on a freshly loaded/written tree
/// reports accurate hashes.
fn classify(child: &holo_tree::Child) -> (&'static str, String, u32) {
    match child {
        holo_tree::Child::Tree(t) => ("tree", oid_hex(t.hash), 0o040000),
        holo_tree::Child::Blob { mode, hash } => ("blob", oid_hex(*hash), u32::from(*mode)),
        holo_tree::Child::Commit { hash } => ("commit", oid_hex(*hash), 0o160000),
    }
}

// ── Tree ────────────────────────────────────────────────────────────────────

/// A mutable, in-memory git tree.
///
/// Holds its own clone of the repo handle so JS callers don't thread a repo
/// argument through every call.
///
/// Owns its `TreeCache` (Phase-C finding #5): the cache travels with the
/// `Tree` object rather than living in thread-implicit state, so whichever
/// thread the JS engine dispatches a call on sees the same cache — see
/// `specs/api/errors.md` § Thread-safety expectations.
#[napi]
pub struct Tree {
    repo: gix::ThreadSafeRepository,
    cache: TreeCache,
    inner: MutableTree,
}

#[napi]
impl Tree {
    /// Hash `content` (UTF-8 text) as a blob and insert it at `path`, creating
    /// intermediate trees as needed. Returns the blob hash.
    #[napi(catch_unwind)]
    pub fn write_child(&mut self, path: String, content: String) -> Result<String, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let oid = self
                .inner
                .write_child(&ctx, &path, &content)
                .map_err(ht_err)?;
            Ok(oid_hex(oid))
        })
    }

    /// Hash raw bytes as a blob and insert at `path`. Binary-safe.
    #[napi(catch_unwind)]
    pub fn write_child_bytes(&mut self, path: String, content: Buffer) -> Result<String, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let oid = self
                .inner
                .write_child_bytes(&ctx, &path, content.as_ref())
                .map_err(ht_err)?;
            Ok(oid_hex(oid))
        })
    }

    /// Place an already-written blob at `path` by its `hash`, without reading its
    /// bytes. Unlike `writeChildBytes` (which re-hashes content), this grafts a
    /// blob already in the ODB — validated to exist and be a blob via a header
    /// lookup, so a large attachment isn't read back and re-hashed. `mode` is the
    /// git filemode: `0o100644` regular, `0o100755` executable, `0o120000`
    /// symlink. Returns the placed hash.
    #[napi(catch_unwind)]
    pub fn write_child_hash(
        &mut self,
        path: String,
        hash: String,
        mode: u32,
    ) -> Result<String, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let oid = parse_oid(&hash)?;
            let mode =
                u16::try_from(mode).map_err(|_| invalid_arg(format!("invalid blob mode {mode:o}")))?;
            self.inner
                .write_child_hash(&ctx, &path, oid, mode)
                .map_err(ht_err)?;
            Ok(oid_hex(oid))
        })
    }

    /// Read a blob's bytes at `path`, or `null` if no blob exists there.
    #[napi(catch_unwind)]
    pub fn read_blob(&mut self, path: String) -> Result<Option<Buffer>, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let bytes = self.inner.read_blob(&ctx, &path).map_err(ht_err)?;
            Ok(bytes.map(Buffer::from))
        })
    }

    /// Read-only: look up the child at a deep `path` and report its type,
    /// hash, and mode, or `null` if nothing exists there.
    #[napi(catch_unwind)]
    pub fn get_child(&mut self, path: String) -> Result<Option<ChildInfo>, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let info = self
                .inner
                .get_child(&ctx, &path)
                .map_err(ht_err)?
                .map(|child| {
                    let (ty, hash, mode) = classify(child);
                    ChildInfo {
                        r#type: ty.to_string(),
                        hash,
                        mode,
                    }
                });
            Ok(info)
        })
    }

    /// Read-only: list the direct children of the subtree at `path` (use `"."`
    /// for the root). Returns an empty array if `path` is missing or not a tree.
    #[napi(catch_unwind)]
    pub fn get_children(&mut self, path: String) -> Result<Vec<NamedChildInfo>, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let subtree = match self.inner.get_subtree(&ctx, &path).map_err(ht_err)? {
                Some(t) => t,
                None => return Ok(vec![]),
            };
            subtree.ensure_children(&ctx).map_err(ht_err)?;
            let mut out = Vec::new();
            for (name, child) in subtree.children.iter().flatten() {
                let (ty, hash, mode) = classify(child);
                out.push(NamedChildInfo {
                    name: name.clone(),
                    r#type: ty.to_string(),
                    hash,
                    mode,
                });
            }
            Ok(out)
        })
    }

    /// Read-only: recursively collect every blob under the subtree at `path`
    /// (defaults to the whole tree) into a flat list. Each `path` is relative
    /// to the navigated subtree. Returns an empty array if `path` is missing.
    #[napi(catch_unwind)]
    pub fn get_blob_map(&mut self, path: Option<String>) -> Result<Vec<BlobEntry>, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let path = path.unwrap_or_else(|| ".".to_string());
            let map = match self.inner.get_subtree(&ctx, &path).map_err(ht_err)? {
                Some(subtree) => subtree.get_blob_map(&ctx).map_err(ht_err)?,
                None => return Ok(vec![]),
            };
            let out = map
                .into_iter()
                .map(|(p, info)| BlobEntry {
                    path: p,
                    hash: oid_hex(info.hash),
                    mode: u32::from(info.mode),
                })
                .collect();
            Ok(out)
        })
    }

    /// Delete a child at a deep `path`. Returns whether it existed.
    #[napi(catch_unwind)]
    pub fn delete_child_deep(&mut self, path: String) -> Result<bool, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            self.inner.delete_child_deep(&ctx, &path).map_err(ht_err)
        })
    }

    /// Clear all children under a deep `path` in O(1) — replace the subtree
    /// there with the empty tree (and dirty its ancestors) without loading the
    /// cleared subtree's contents. `path == "."` clears the whole tree. Used to
    /// wipe a directory before a full rewrite.
    #[napi(catch_unwind)]
    pub fn clear_children(&mut self, path: String) -> Result<(), ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            self.inner.clear_children(&ctx, &path).map_err(ht_err)
        })
    }

    /// Merge another tree into this one in place, per `options.mode`
    /// (`overlay`/`replace`/`underlay`) and optional `options.files` globs.
    /// `other` must be a *different* `Tree` instance.
    #[napi(catch_unwind)]
    pub fn merge(&mut self, other: &mut Tree, options: MergeOpts) -> Result<(), ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let mode = match options.mode.as_str() {
                "overlay" => holo_tree::MergeMode::Overlay,
                "replace" => holo_tree::MergeMode::Replace,
                "underlay" => holo_tree::MergeMode::Underlay,
                other_mode => {
                    return Err(invalid_arg(format!(
                        "invalid merge mode '{other_mode}', expected 'overlay', 'replace', or 'underlay'"
                    )))
                }
            };
            let opts =
                holo_tree::MergeOptions::new(options.files.as_deref(), mode).map_err(ht_err)?;
            self.inner
                .merge(&ctx, &mut other.inner, &opts, ".")
                .map_err(ht_err)
        })
    }

    /// Flush dirty subtrees to the ODB and return the resulting tree hash.
    #[napi(catch_unwind)]
    pub fn write(&mut self) -> Result<String, ErrorCode> {
        contained(|| {
            let local = self.repo.to_thread_local();
            let ctx = Context::new(&local, &self.cache);
            let oid = self.inner.write(&ctx).map_err(ht_err)?;
            Ok(oid_hex(oid))
        })
    }
}
