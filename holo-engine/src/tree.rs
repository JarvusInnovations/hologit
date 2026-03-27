//! In-memory mutable git tree with merge, dirty tracking, and write-back.
//!
//! This is the innermost hot path of the projection engine. It provides
//! `MutableTree`, which lazily loads children from the git ODB via gix,
//! supports three merge modes (overlay, replace, underlay), and writes
//! modified trees back to the ODB.
//!
//! Key design decisions:
//! - `BTreeMap` for deterministic iteration matching git's canonical sort
//! - Thread-local cache eliminates redundant ODB reads across recursive projections
//! - "Clone clean input" optimization skips loading trees that pass through unchanged
//! - Dirty propagation in `get_or_create_subtree` marks all ancestors

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};

use gix::bstr::ByteSlice;
use gix::object::tree::EntryKind;
use gix::objs::tree::{Entry as GixEntry, EntryMode};
use gix::objs::Tree as GixTree;
use gix::ObjectId;

use crate::error::{Error, Result};
use crate::glob::GlobMatcher;

// ── Stats ──────────────────────────────────────────────────────────────────

/// Performance counters for tree operations.
pub struct Stats {
    pub trees_read: u64,
    pub trees_written: u64,
    pub trees_skipped_clean: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub blobs_read: u64,
}

static TREES_READ: AtomicU64 = AtomicU64::new(0);
static TREES_WRITTEN: AtomicU64 = AtomicU64::new(0);
static TREES_SKIPPED_CLEAN: AtomicU64 = AtomicU64::new(0);
static CACHE_HITS: AtomicU64 = AtomicU64::new(0);
static CACHE_MISSES: AtomicU64 = AtomicU64::new(0);
static BLOBS_READ: AtomicU64 = AtomicU64::new(0);

/// Return current performance statistics.
pub fn stats() -> Stats {
    Stats {
        trees_read: TREES_READ.load(Ordering::Relaxed),
        trees_written: TREES_WRITTEN.load(Ordering::Relaxed),
        trees_skipped_clean: TREES_SKIPPED_CLEAN.load(Ordering::Relaxed),
        cache_hits: CACHE_HITS.load(Ordering::Relaxed),
        cache_misses: CACHE_MISSES.load(Ordering::Relaxed),
        blobs_read: BLOBS_READ.load(Ordering::Relaxed),
    }
}

/// Reset all stats counters and the tree cache.
pub fn reset() {
    TREES_READ.store(0, Ordering::Relaxed);
    TREES_WRITTEN.store(0, Ordering::Relaxed);
    TREES_SKIPPED_CLEAN.store(0, Ordering::Relaxed);
    CACHE_HITS.store(0, Ordering::Relaxed);
    CACHE_MISSES.store(0, Ordering::Relaxed);
    BLOBS_READ.store(0, Ordering::Relaxed);
    TREE_CACHE.with(|c| c.borrow_mut().clear());
}

// ── Tree cache ─────────────────────────────────────────────────────────────

/// Parsed tree entry for the module-level cache.
#[derive(Debug, Clone)]
struct CachedEntry {
    name: String,
    entry_type: EntryType,
    mode: u16,
    hash: ObjectId,
}

thread_local! {
    static TREE_CACHE: RefCell<HashMap<ObjectId, Vec<CachedEntry>>> =
        RefCell::new(HashMap::new());
}

fn cache_read(hash: &ObjectId) -> Option<Vec<CachedEntry>> {
    TREE_CACHE.with(|c| {
        let cache = c.borrow();
        match cache.get(hash) {
            Some(entries) => {
                CACHE_HITS.fetch_add(1, Ordering::Relaxed);
                Some(entries.clone())
            }
            None => {
                CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    })
}

fn cache_write(hash: ObjectId, entries: Vec<CachedEntry>) {
    TREE_CACHE.with(|c| {
        c.borrow_mut().insert(hash, entries);
    });
}

// ── Constants ──────────────────────────────────────────────────────────────

const EMPTY_TREE_HEX: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Git's well-known empty tree hash.
pub fn empty_tree_id() -> ObjectId {
    ObjectId::from_hex(EMPTY_TREE_HEX.as_bytes()).unwrap()
}

// ── Entry classification ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryType {
    Tree,
    Blob,
    Commit,
}

impl EntryType {
    fn from_kind(kind: EntryKind) -> Self {
        match kind {
            EntryKind::Tree => EntryType::Tree,
            EntryKind::Blob | EntryKind::BlobExecutable | EntryKind::Link => EntryType::Blob,
            EntryKind::Commit => EntryType::Commit,
        }
    }
}

// ── Merge mode ─────────────────────────────────────────────────────────────

/// How input entries interact with existing target entries during merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMode {
    /// Input overwrites target; target entries not in input are preserved.
    Overlay,
    /// Input replaces target entirely; target entries not in input are removed.
    Replace,
    /// Input only fills gaps; existing target entries are never overwritten.
    Underlay,
}

// ── Merge options ──────────────────────────────────────────────────────────

/// Options controlling a tree merge: mode + file patterns.
pub struct MergeOptions {
    pub mode: MergeMode,
    pub matcher: GlobMatcher,
}

impl MergeOptions {
    pub fn new(files: Option<&[String]>, mode: MergeMode) -> Result<Self> {
        Ok(MergeOptions {
            mode,
            matcher: GlobMatcher::new(files)?,
        })
    }
}

// ── Child ──────────────────────────────────────────────────────────────────

/// A child entry in a `MutableTree`.
pub enum Child {
    Tree(MutableTree),
    Blob { mode: u16, hash: ObjectId },
    Commit { hash: ObjectId },
}

fn child_hash(child: &Child) -> Option<ObjectId> {
    match child {
        Child::Tree(t) => Some(t.hash),
        Child::Blob { hash, .. } => Some(*hash),
        Child::Commit { hash } => Some(*hash),
    }
}

fn child_is_dirty(child: &Child) -> bool {
    matches!(child, Child::Tree(t) if t.dirty)
}

fn clone_child(child: &Child) -> Child {
    match child {
        Child::Tree(t) => Child::Tree(MutableTree::new(t.hash)),
        Child::Blob { mode, hash } => Child::Blob {
            mode: *mode,
            hash: *hash,
        },
        Child::Commit { hash } => Child::Commit { hash: *hash },
    }
}

// ── MutableTree ────────────────────────────────────────────────────────────

/// An in-memory mutable git tree node.
///
/// Children are loaded lazily from the ODB on first access. Modifications
/// set the `dirty` flag, and `write()` recursively writes only dirty subtrees.
pub struct MutableTree {
    pub hash: ObjectId,
    pub dirty: bool,
    pub children: Option<BTreeMap<String, Child>>,
}

impl MutableTree {
    /// Create a tree node referencing an existing git tree object.
    /// Children will be loaded lazily on first access.
    pub fn new(hash: ObjectId) -> Self {
        MutableTree {
            hash,
            dirty: false,
            children: None,
        }
    }

    /// Create an empty tree (no children, hash = empty tree).
    pub fn empty() -> Self {
        MutableTree {
            hash: empty_tree_id(),
            dirty: false,
            children: Some(BTreeMap::new()),
        }
    }

    // ── Child loading ────────────────────────────────────────────────────

    /// Load children from the git ODB if not yet loaded.
    /// Checks the module-level cache first.
    pub fn ensure_children(&mut self, repo: &gix::Repository) -> Result<()> {
        if self.children.is_some() {
            return Ok(());
        }

        if self.hash == empty_tree_id() {
            self.children = Some(BTreeMap::new());
            return Ok(());
        }

        let entries = match cache_read(&self.hash) {
            Some(cached) => cached,
            None => {
                let obj = repo.find_object(self.hash)?;
                let tree = obj
                    .try_into_tree()
                    .map_err(|_| Error::Git(format!("{} is not a tree", self.hash)))?;

                TREES_READ.fetch_add(1, Ordering::Relaxed);

                let entries: Vec<CachedEntry> = tree
                    .iter()
                    .map(|r| {
                        let e = r.map_err(|e| Error::Git(e.to_string()))?;
                        Ok(CachedEntry {
                            name: e
                                .filename()
                                .to_str()
                                .unwrap_or(
                                    &String::from_utf8_lossy(e.filename().as_ref()),
                                )
                                .to_owned(),
                            entry_type: EntryType::from_kind(e.mode().kind()),
                            mode: e.mode().value(),
                            hash: e.oid().to_owned(),
                        })
                    })
                    .collect::<Result<_>>()?;

                cache_write(self.hash, entries.clone());
                entries
            }
        };

        let mut children = BTreeMap::new();
        for e in entries {
            let child = match e.entry_type {
                EntryType::Tree => Child::Tree(MutableTree::new(e.hash)),
                EntryType::Blob => Child::Blob {
                    mode: e.mode,
                    hash: e.hash,
                },
                EntryType::Commit => Child::Commit { hash: e.hash },
            };
            children.insert(e.name, child);
        }
        self.children = Some(children);
        Ok(())
    }

    // ── Navigation ───────────────────────────────────────────────────────

    /// Navigate to a subtree by slash-separated path. Returns `None` if
    /// any component is missing or not a tree.
    pub fn get_subtree(
        &mut self,
        repo: &gix::Repository,
        path: &str,
    ) -> Result<Option<&mut MutableTree>> {
        if path == "." || path.is_empty() {
            return Ok(Some(self));
        }

        let parts: Vec<&str> = path.split('/').collect();
        let mut cur = self;

        for part in parts {
            cur.ensure_children(repo)?;
            match cur.children.as_mut().unwrap().get_mut(part) {
                Some(Child::Tree(ref mut t)) => cur = t,
                _ => return Ok(None),
            }
        }
        Ok(Some(cur))
    }

    /// Navigate to a subtree, creating intermediate empty trees as needed.
    ///
    /// **Marks all ancestors dirty** when any new node is created, matching
    /// the JS `getSubtreeStack(path, create=true)` behavior.
    pub fn get_or_create_subtree(
        &mut self,
        repo: &gix::Repository,
        path: &str,
    ) -> Result<&mut MutableTree> {
        if path == "." || path.is_empty() {
            return Ok(self);
        }

        let parts: Vec<&str> = path.split('/').collect();

        // First pass: detect whether any node needs to be created.
        let mut needs_create = false;
        {
            let mut check = &mut *self;
            for part in &parts {
                check.ensure_children(repo)?;
                if !check.children.as_ref().unwrap().contains_key(*part) {
                    needs_create = true;
                    break;
                }
                match check.children.as_mut().unwrap().get_mut(*part) {
                    Some(Child::Tree(ref mut t)) => check = t,
                    _ => break,
                }
            }
        }

        if needs_create {
            self.dirty = true;
        }

        // Second pass: create missing nodes.
        let mut cur = self;
        for part in parts {
            cur.ensure_children(repo)?;
            let children = cur.children.as_mut().unwrap();

            let child = children.entry(part.to_string()).or_insert_with(|| {
                let mut t = MutableTree::empty();
                t.dirty = true;
                Child::Tree(t)
            });

            cur = match child {
                Child::Tree(ref mut t) => {
                    if needs_create {
                        t.dirty = true;
                    }
                    t
                }
                _ => {
                    return Err(Error::Other(format!(
                        "path component '{}' exists but is not a tree",
                        part
                    )))
                }
            };
        }
        Ok(cur)
    }

    /// Read a blob's raw bytes by navigating a slash-separated path.
    pub fn read_blob(
        &mut self,
        repo: &gix::Repository,
        path: &str,
    ) -> Result<Option<Vec<u8>>> {
        let (dir, file) = match path.rsplit_once('/') {
            Some((d, f)) => (d, f),
            None => (".", path),
        };

        let tree = if dir == "." {
            self
        } else {
            match self.get_subtree(repo, dir)? {
                Some(t) => t,
                None => return Ok(None),
            }
        };

        tree.ensure_children(repo)?;
        match tree.children.as_ref().unwrap().get(file) {
            Some(Child::Blob { hash, .. }) => {
                BLOBS_READ.fetch_add(1, Ordering::Relaxed);
                let obj = repo.find_object(*hash)?;
                Ok(Some(obj.data.to_vec()))
            }
            _ => Ok(None),
        }
    }

    /// Remove a direct child by name. Returns whether it existed.
    pub fn delete_child(
        &mut self,
        repo: &gix::Repository,
        name: &str,
    ) -> Result<bool> {
        self.ensure_children(repo)?;
        if self.children.as_mut().unwrap().remove(name).is_some() {
            self.dirty = true;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    // ── Merge ────────────────────────────────────────────────────────────

    /// Merge another tree into this one.
    ///
    /// This is the core hot-path algorithm, ported from `TreeObject.merge()`
    /// in the JS codebase. See SPEC.md § Merge algorithm for the full
    /// pseudocode and invariants.
    pub fn merge(
        &mut self,
        repo: &gix::Repository,
        input: &mut MutableTree,
        opts: &MergeOptions,
        base_path: &str,
    ) -> Result<()> {
        self.ensure_children(repo)?;
        input.ensure_children(repo)?;

        let input_names: Vec<String> = input
            .children
            .as_ref()
            .unwrap()
            .keys()
            .cloned()
            .collect();

        for child_name in &input_names {
            let input_child = match input.children.as_ref().unwrap().get(child_name) {
                Some(c) => c,
                None => continue,
            };

            // Skip identical clean subtrees
            if let Some(base_child) = self.children.as_ref().unwrap().get(child_name) {
                if child_hash(base_child) == child_hash(input_child)
                    && !child_is_dirty(base_child)
                    && !child_is_dirty(input_child)
                {
                    continue;
                }
            }

            let is_tree = matches!(input_child, Child::Tree(_));

            // Build child path for glob matching
            let child_path = if base_path == "." {
                if is_tree {
                    format!("{child_name}/")
                } else {
                    child_name.clone()
                }
            } else if is_tree {
                format!("{base_path}{child_name}/")
            } else {
                format!("{base_path}{child_name}")
            };

            // ── Glob filtering ───────────────────────────────────────────
            let mut pending_child_match = false;
            if opts.matcher.has_patterns() {
                let (matched, excluded) = opts.matcher.matches(&child_path);

                if excluded {
                    continue;
                }
                if !matched && !is_tree {
                    continue;
                }
                if is_tree && (!matched || opts.matcher.has_negations()) {
                    pending_child_match = true;
                }
            }

            // ── Blob / commit ────────────────────────────────────────────
            if !is_tree {
                let should_write = match opts.mode {
                    MergeMode::Underlay => {
                        !self.children.as_ref().unwrap().contains_key(child_name)
                    }
                    MergeMode::Overlay | MergeMode::Replace => true,
                };
                if should_write {
                    self.children
                        .as_mut()
                        .unwrap()
                        .insert(child_name.clone(), clone_child(input_child));
                    self.dirty = true;
                }
                continue;
            }

            // ── Tree ─────────────────────────────────────────────────────
            let has_base_tree = matches!(
                self.children.as_ref().unwrap().get(child_name),
                Some(Child::Tree(_))
            );

            if !has_base_tree || opts.mode == MergeMode::Replace {
                // No existing tree (or replace mode) — three sub-cases:

                if pending_child_match {
                    // (a) Glob undecided: merge into temp, keep only if dirty
                    let mut temp = MutableTree::empty();
                    let it = match input.children.as_mut().unwrap().get_mut(child_name)
                    {
                        Some(Child::Tree(t)) => t,
                        _ => unreachable!(),
                    };
                    temp.merge(repo, it, opts, &child_path)?;
                    if temp.dirty {
                        self.children
                            .as_mut()
                            .unwrap()
                            .insert(child_name.clone(), Child::Tree(temp));
                        self.dirty = true;
                    }
                    continue;
                }

                let input_ref =
                    input.children.as_ref().unwrap().get(child_name).unwrap();
                if !child_is_dirty(input_ref) {
                    // (b) Input child is clean — clone by hash, skip merge
                    let h = child_hash(input_ref).unwrap();
                    self.children
                        .as_mut()
                        .unwrap()
                        .insert(child_name.clone(), Child::Tree(MutableTree::new(h)));
                    self.dirty = true;
                    continue;
                }

                // (c) Input child is dirty — merge into new empty tree
                let it = match input.children.as_mut().unwrap().get_mut(child_name) {
                    Some(Child::Tree(t)) => t,
                    _ => unreachable!(),
                };
                let mut new_base = MutableTree::empty();
                new_base.merge(repo, it, opts, &child_path)?;
                if new_base.dirty {
                    self.dirty = true;
                }
                self.children
                    .as_mut()
                    .unwrap()
                    .insert(child_name.clone(), Child::Tree(new_base));
                continue;
            }

            // Both sides are trees — recursive merge
            let mut input_tree =
                match input.children.as_mut().unwrap().remove(child_name) {
                    Some(Child::Tree(t)) => t,
                    _ => unreachable!(),
                };

            let base_tree =
                match self.children.as_mut().unwrap().get_mut(child_name) {
                    Some(Child::Tree(ref mut t)) => t,
                    _ => unreachable!(),
                };

            base_tree.merge(repo, &mut input_tree, opts, &child_path)?;
            if base_tree.dirty {
                self.dirty = true;
            }

            // Restore input tree (we borrowed it temporarily)
            input
                .children
                .as_mut()
                .unwrap()
                .insert(child_name.clone(), Child::Tree(input_tree));
        }

        // Replace mode: remove target children absent from input
        if opts.mode == MergeMode::Replace {
            let input_children = input.children.as_ref().unwrap();
            let self_children = self.children.as_mut().unwrap();
            let to_remove: Vec<String> = self_children
                .keys()
                .filter(|k| !input_children.contains_key(*k))
                .cloned()
                .collect();
            for key in to_remove {
                self_children.remove(&key);
                self.dirty = true;
            }
        }

        Ok(())
    }

    // ── Write ────────────────────────────────────────────────────────────

    /// Recursively write dirty trees to the git ODB.
    /// Returns the hash of this tree.
    pub fn write(&mut self, repo: &gix::Repository) -> Result<ObjectId> {
        if !self.dirty {
            TREES_SKIPPED_CLEAN.fetch_add(1, Ordering::Relaxed);
            return Ok(self.hash);
        }

        if self.children.is_none() {
            self.ensure_children(repo)?;
        }

        let children = self.children.as_mut().unwrap();

        // Recurse into dirty child trees
        let names: Vec<String> = children.keys().cloned().collect();
        for name in &names {
            if let Some(Child::Tree(ref mut ct)) = children.get_mut(name) {
                if ct.dirty {
                    ct.write(repo)?;
                }
            }
        }

        // Build gix entry list
        let mut entries: Vec<GixEntry> = Vec::new();
        for (name, child) in children.iter() {
            match child {
                Child::Tree(t) if t.hash == empty_tree_id() => continue,
                Child::Tree(t) => entries.push(GixEntry {
                    mode: EntryMode::try_from(0o040000u32).unwrap(),
                    filename: name.as_str().into(),
                    oid: t.hash,
                }),
                Child::Blob { mode, hash } => entries.push(GixEntry {
                    mode: EntryMode::try_from(*mode as u32).unwrap(),
                    filename: name.as_str().into(),
                    oid: *hash,
                }),
                Child::Commit { hash } => entries.push(GixEntry {
                    mode: EntryMode::try_from(0o160000u32).unwrap(),
                    filename: name.as_str().into(),
                    oid: *hash,
                }),
            }
        }

        if entries.is_empty() {
            self.hash = empty_tree_id();
        } else {
            entries.sort();
            let tree = GixTree { entries };
            let id = repo.write_object(&tree)?;
            self.hash = id.detach();
            TREES_WRITTEN.fetch_add(1, Ordering::Relaxed);
        }

        self.dirty = false;
        Ok(self.hash)
    }
}
