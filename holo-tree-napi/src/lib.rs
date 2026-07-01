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
//!
//! This binding is a deliberately thin pass-through. Per the spike's governing
//! principle (see `plans/holo-tree-napi-spike.md` in gitsheets), rough edges in
//! holo-tree's API are recorded as `Phase-C finding` notes and fixed upstream —
//! not papered over with cleverness here.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use holo_tree::repo as ht_repo;
use holo_tree::tree::empty_tree_id;
use holo_tree::{MutableTree, ObjectId};

// ── helpers ─────────────────────────────────────────────────────────────────

/// Map a holo-tree error into a JS exception.
///
/// Phase-C finding: `holo_tree::Error` collapses to a flat string here. gitsheets
/// needs to translate substrate failures into its typed error classes, which a
/// stringified `Display` makes lossy — candidate upstream improvement is a stable
/// error code / structured variant that survives FFI.
fn ht_err(e: holo_tree::Error) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

fn parse_oid(hex: &str) -> napi::Result<ObjectId> {
    ObjectId::from_hex(hex.as_bytes())
        .map_err(|e| napi::Error::from_reason(format!("invalid object id '{hex}': {e}")))
}

fn oid_hex(oid: ObjectId) -> String {
    oid.to_hex().to_string()
}

/// Git's well-known empty-tree hash (`4b825dc6…`).
#[napi]
pub fn empty_tree_hash() -> String {
    oid_hex(empty_tree_id())
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

fn to_gix_signature(sig: Signature) -> napi::Result<gix::actor::Signature> {
    let seconds = sig.time_seconds.unwrap_or_else(now_secs);
    let time = format_git_time(seconds, sig.offset_minutes.unwrap_or(0));
    gix::actor::SignatureRef {
        name: sig.name.as_str().into(),
        email: sig.email.as_str().into(),
        time: &time,
    }
    .to_owned()
    .map_err(|e| napi::Error::from_reason(format!("invalid signature time: {e}")))
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
    #[napi(factory)]
    pub fn open(git_dir: String) -> napi::Result<Repo> {
        let inner = gix::open(&git_dir)
            .map_err(|e| {
                napi::Error::from_reason(format!("failed to open repo at '{git_dir}': {e}"))
            })?
            .into_sync();
        Ok(Repo { inner })
    }

    /// Resolve a ref (branch, tag, or commit hash) to its tree and return a
    /// mutable, in-memory view of it.
    #[napi]
    pub fn create_tree_from_ref(&self, git_ref: String) -> napi::Result<Tree> {
        let local = self.inner.to_thread_local();
        let inner = ht_repo::create_tree_from_ref(&local, &git_ref).map_err(ht_err)?;
        Ok(Tree {
            repo: self.inner.clone(),
            inner,
        })
    }

    /// Create a fresh empty, mutable in-memory tree rooted at this repo.
    #[napi]
    pub fn create_tree(&self) -> Tree {
        Tree {
            repo: self.inner.clone(),
            inner: MutableTree::empty(),
        }
    }

    /// Write a commit object pointing at `treeHash` with `parents`. `author`
    /// and `committer` are optional; each falls back to the repo's configured
    /// identity, then a "holo-tree" default. Returns the new commit hash.
    #[napi]
    pub fn commit_tree(
        &self,
        tree_hash: String,
        parents: Vec<String>,
        message: String,
        author: Option<Signature>,
        committer: Option<Signature>,
    ) -> napi::Result<String> {
        let local = self.inner.to_thread_local();
        let tree = parse_oid(&tree_hash)?;
        let parent_oids = parents
            .iter()
            .map(|p| parse_oid(p))
            .collect::<napi::Result<Vec<_>>>()?;
        let author = author.map(to_gix_signature).transpose()?;
        let committer = committer.map(to_gix_signature).transpose()?;
        let commit = ht_repo::commit_tree(&local, tree, &parent_oids, &message, author, committer)
            .map_err(ht_err)?;
        Ok(oid_hex(commit))
    }

    /// Point a ref at an object hash.
    ///
    /// When `expectedOldHash` is provided this is a **compare-and-swap**: the
    /// update only succeeds if the ref currently resolves to exactly that hash,
    /// so a concurrent writer who moved the ref makes the swap fail rather than
    /// silently clobbering their commit. Omit it to force the ref (the prior
    /// unconditional behavior).
    #[napi]
    pub fn update_ref(
        &self,
        refname: String,
        hash: String,
        expected_old_hash: Option<String>,
    ) -> napi::Result<()> {
        let local = self.inner.to_thread_local();
        let oid = parse_oid(&hash)?;
        let expected = expected_old_hash.as_deref().map(parse_oid).transpose()?;
        ht_repo::update_ref(&local, &refname, oid, expected).map_err(ht_err)
    }

    /// Resolve a ref / rev-spec (branch, tag, `HEAD`, hash, …) to its commit
    /// hash, peeling annotated tags. Returns `null` when the ref does not
    /// resolve — the natural "does this ref exist?" probe before a CAS
    /// `updateRef`.
    #[napi]
    pub fn resolve_ref(&self, git_ref: String) -> napi::Result<Option<String>> {
        let local = self.inner.to_thread_local();
        let oid = ht_repo::resolve_ref(&local, &git_ref).map_err(ht_err)?;
        Ok(oid.map(oid_hex))
    }

    /// Hash raw bytes as a loose blob in the ODB and return its hash, without
    /// inserting it into any tree. Binary-safe.
    #[napi]
    pub fn write_blob(&self, content: Buffer) -> napi::Result<String> {
        let local = self.inner.to_thread_local();
        let oid = local
            .write_blob(content.as_ref())
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .detach();
        Ok(oid_hex(oid))
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
/// Phase-C finding #1: holo-tree's `MutableTree` takes `&gix::Repository` on
/// nearly every method and keeps a *thread-local* tree cache. We smooth the
/// first half here (the handle lives on the `Tree`) but NOT the second: each
/// call does `to_thread_local()`, and whether holo-tree's thread-local cache
/// stays warm across libuv-dispatched calls is the open ergonomics question to
/// resolve upstream (e.g. a repo-bound tree handle, or an explicit session/
/// cache object the consumer owns).
#[napi]
pub struct Tree {
    repo: gix::ThreadSafeRepository,
    inner: MutableTree,
}

#[napi]
impl Tree {
    /// Hash `content` (UTF-8 text) as a blob and insert it at `path`, creating
    /// intermediate trees as needed. Returns the blob hash.
    #[napi]
    pub fn write_child(&mut self, path: String, content: String) -> napi::Result<String> {
        let local = self.repo.to_thread_local();
        let oid = self
            .inner
            .write_child(&local, &path, &content)
            .map_err(ht_err)?;
        Ok(oid_hex(oid))
    }

    /// Hash raw bytes as a blob and insert at `path`. Binary-safe.
    #[napi]
    pub fn write_child_bytes(&mut self, path: String, content: Buffer) -> napi::Result<String> {
        let local = self.repo.to_thread_local();
        let oid = self
            .inner
            .write_child_bytes(&local, &path, content.as_ref())
            .map_err(ht_err)?;
        Ok(oid_hex(oid))
    }

    /// Place an already-written blob at `path` by its `hash`, without reading its
    /// bytes. Unlike `writeChildBytes` (which re-hashes content), this grafts a
    /// blob already in the ODB — validated to exist and be a blob via a header
    /// lookup, so a large attachment isn't read back and re-hashed. `mode` is the
    /// git filemode: `0o100644` regular, `0o100755` executable, `0o120000`
    /// symlink. Returns the placed hash.
    #[napi]
    pub fn write_child_hash(
        &mut self,
        path: String,
        hash: String,
        mode: u32,
    ) -> napi::Result<String> {
        let local = self.repo.to_thread_local();
        let oid = parse_oid(&hash)?;
        let mode = u16::try_from(mode)
            .map_err(|_| napi::Error::from_reason(format!("invalid blob mode {mode:o}")))?;
        self.inner
            .write_child_hash(&local, &path, oid, mode)
            .map_err(ht_err)?;
        Ok(oid_hex(oid))
    }

    /// Read a blob's bytes at `path`, or `null` if no blob exists there.
    #[napi]
    pub fn read_blob(&mut self, path: String) -> napi::Result<Option<Buffer>> {
        let local = self.repo.to_thread_local();
        let bytes = self.inner.read_blob(&local, &path).map_err(ht_err)?;
        Ok(bytes.map(Buffer::from))
    }

    /// Read-only: look up the child at a deep `path` and report its type,
    /// hash, and mode, or `null` if nothing exists there.
    #[napi]
    pub fn get_child(&mut self, path: String) -> napi::Result<Option<ChildInfo>> {
        let local = self.repo.to_thread_local();
        let info = self
            .inner
            .get_child(&local, &path)
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
    }

    /// Read-only: list the direct children of the subtree at `path` (use `"."`
    /// for the root). Returns an empty array if `path` is missing or not a tree.
    #[napi]
    pub fn get_children(&mut self, path: String) -> napi::Result<Vec<NamedChildInfo>> {
        let local = self.repo.to_thread_local();
        let subtree = match self.inner.get_subtree(&local, &path).map_err(ht_err)? {
            Some(t) => t,
            None => return Ok(vec![]),
        };
        subtree.ensure_children(&local).map_err(ht_err)?;
        let mut out = Vec::new();
        for (name, child) in subtree.children.as_ref().unwrap().iter() {
            let (ty, hash, mode) = classify(child);
            out.push(NamedChildInfo {
                name: name.clone(),
                r#type: ty.to_string(),
                hash,
                mode,
            });
        }
        Ok(out)
    }

    /// Read-only: recursively collect every blob under the subtree at `path`
    /// (defaults to the whole tree) into a flat list. Each `path` is relative
    /// to the navigated subtree. Returns an empty array if `path` is missing.
    #[napi]
    pub fn get_blob_map(&mut self, path: Option<String>) -> napi::Result<Vec<BlobEntry>> {
        let local = self.repo.to_thread_local();
        let path = path.unwrap_or_else(|| ".".to_string());
        let map = match self.inner.get_subtree(&local, &path).map_err(ht_err)? {
            Some(subtree) => subtree.get_blob_map(&local).map_err(ht_err)?,
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
    }

    /// Delete a child at a deep `path`. Returns whether it existed.
    #[napi]
    pub fn delete_child_deep(&mut self, path: String) -> napi::Result<bool> {
        let local = self.repo.to_thread_local();
        self.inner
            .delete_child_deep(&local, &path)
            .map_err(ht_err)
    }

    /// Clear all children under a deep `path` in O(1) — replace the subtree
    /// there with the empty tree (and dirty its ancestors) without loading the
    /// cleared subtree's contents. `path == "."` clears the whole tree. Used to
    /// wipe a directory before a full rewrite.
    #[napi]
    pub fn clear_children(&mut self, path: String) -> napi::Result<()> {
        let local = self.repo.to_thread_local();
        self.inner.clear_children(&local, &path).map_err(ht_err)
    }

    /// Merge another tree into this one in place, per `options.mode`
    /// (`overlay`/`replace`/`underlay`) and optional `options.files` globs.
    /// `other` must be a *different* `Tree` instance.
    #[napi]
    pub fn merge(&mut self, other: &mut Tree, options: MergeOpts) -> napi::Result<()> {
        let local = self.repo.to_thread_local();
        let mode = match options.mode.as_str() {
            "overlay" => holo_tree::MergeMode::Overlay,
            "replace" => holo_tree::MergeMode::Replace,
            "underlay" => holo_tree::MergeMode::Underlay,
            other => {
                return Err(napi::Error::from_reason(format!(
                    "invalid merge mode '{other}', expected 'overlay', 'replace', or 'underlay'"
                )))
            }
        };
        let opts = holo_tree::MergeOptions::new(options.files.as_deref(), mode).map_err(ht_err)?;
        self.inner
            .merge(&local, &mut other.inner, &opts, ".")
            .map_err(ht_err)
    }

    /// Flush dirty subtrees to the ODB and return the resulting tree hash.
    #[napi]
    pub fn write(&mut self) -> napi::Result<String> {
        let local = self.repo.to_thread_local();
        let oid = self.inner.write(&local).map_err(ht_err)?;
        Ok(oid_hex(oid))
    }
}
