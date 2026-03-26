//! In-memory mutable git tree with merge, dirty tracking, and write-back.
//!
//! This is the Rust equivalent of hologit's TreeObject.js — the performance-critical
//! hot path. Key differences from the Node.js version:
//!
//! - Tree reads go directly through gix's packfile/loose object layer (no subprocess)
//! - Glob matching uses globset's compiled Aho-Corasick automaton (vs per-child minimatch)
//! - No async/await overhead — synchronous blocking I/O is fine for local git ops
//! - HashMap instead of prototype chain trick for base/overlay children

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use gix::bstr::ByteSlice;
use gix::object::tree::EntryKind;
use gix::objs::tree::{Entry as GixEntry, EntryMode};
use gix::objs::Tree as GixTree;
use gix::ObjectId;
use globset::{Glob, GlobSet, GlobSetBuilder};

// ── Stats ──────────────────────────────────────────────────────────────────

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

// ── Tree cache ─────────────────────────────────────────────────────────────

/// Module-level cache: hash → Vec<TreeEntry>
/// Equivalent to the JS `cache = {}` in TreeObject.js
thread_local! {
    static TREE_CACHE: RefCell<HashMap<ObjectId, Vec<TreeEntry>>> = RefCell::new(HashMap::new());
}

fn cache_read(hash: &ObjectId) -> Option<Vec<TreeEntry>> {
    TREE_CACHE.with(|c| {
        let cache = c.borrow();
        if let Some(entries) = cache.get(hash) {
            CACHE_HITS.fetch_add(1, Ordering::Relaxed);
            Some(entries.clone())
        } else {
            CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
            None
        }
    })
}

fn cache_write(hash: ObjectId, entries: Vec<TreeEntry>) {
    TREE_CACHE.with(|c| {
        c.borrow_mut().insert(hash, entries);
    });
}

// ── Constants ──────────────────────────────────────────────────────────────

/// Git's well-known empty tree hash
pub const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub fn empty_tree_id() -> ObjectId {
    ObjectId::from_hex(EMPTY_TREE_HASH.as_bytes()).unwrap()
}

// ── Entry types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryType {
    Tree,
    Blob,
    Commit, // gitlink / submodule
}

impl EntryType {
    pub fn from_kind(kind: EntryKind) -> Self {
        match kind {
            EntryKind::Tree => EntryType::Tree,
            EntryKind::Blob | EntryKind::BlobExecutable | EntryKind::Link => EntryType::Blob,
            EntryKind::Commit => EntryType::Commit,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TreeEntry {
    pub name: String,
    pub entry_type: EntryType,
    pub mode: u16,
    pub hash: ObjectId,
}

// ── Merge mode ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMode {
    Overlay,  // input overwrites target for matching files, leaves others
    Replace,  // input replaces target entirely
    Underlay, // input only fills in where target has no entry
}

impl MergeMode {
    pub fn from_str(s: &str) -> Result<Self> {
        match s {
            "overlay" => Ok(MergeMode::Overlay),
            "replace" => Ok(MergeMode::Replace),
            "underlay" => Ok(MergeMode::Underlay),
            other => bail!("unknown merge mode: {other}"),
        }
    }
}

// ── Merge options ──────────────────────────────────────────────────────────

/// A single pattern that can be positive or negative (negation prefix `!`)
struct PatternEntry {
    glob: GlobSet,
    negate: bool,
    raw: String,
}

pub struct MergeOptions {
    pub mode: MergeMode,
    /// Compiled pattern entries for file filtering. None = match everything.
    patterns: Option<Vec<PatternEntry>>,
}

impl MergeOptions {
    pub fn new(files: Option<&[String]>, mode: MergeMode) -> Result<Self> {
        let patterns = match files {
            Some(pats) if !(pats.len() == 1 && pats[0] == "**") => {
                let mut entries = Vec::new();
                for pat in pats {
                    let (negate, raw_pat) = if let Some(stripped) = pat.strip_prefix('!') {
                        (true, stripped)
                    } else {
                        (false, pat.as_str())
                    };
                    let mut builder = GlobSetBuilder::new();
                    builder.add(
                        Glob::new(raw_pat)
                            .with_context(|| format!("invalid glob: {pat}"))?,
                    );
                    entries.push(PatternEntry {
                        glob: builder.build()?,
                        negate,
                        raw: raw_pat.to_string(),
                    });
                }
                Some(entries)
            }
            _ => None,
        };

        Ok(MergeOptions { mode, patterns })
    }

    /// Check if a path matches the pattern set, following Minimatch semantics:
    /// - A positive match means "include"
    /// - A negative match means "exclude" (and short-circuits)
    /// Returns (matched, negation_excluded)
    fn matches(&self, path: &str) -> (bool, bool) {
        match &self.patterns {
            None => (true, false),
            Some(entries) => {
                let mut matched = false;
                for entry in entries {
                    if entry.glob.is_match(path) {
                        if entry.negate {
                            // Negation match — exclude this path
                            return (false, true);
                        }
                        matched = true;
                    } else if entry.negate {
                        // Negation pattern didn't match — that's fine, path is not excluded
                    }
                }
                (matched, false)
            }
        }
    }

    fn has_patterns(&self) -> bool {
        self.patterns.is_some()
    }

    fn has_negations(&self) -> bool {
        self.patterns
            .as_ref()
            .map(|p| p.iter().any(|e| e.negate))
            .unwrap_or(false)
    }

    /// Check if a directory path *could* contain matches (partial/prefix match).
    fn might_match_children(&self, dir_path: &str) -> bool {
        match &self.patterns {
            None => true,
            Some(entries) => {
                for entry in entries {
                    if entry.raw.contains("**") {
                        return true;
                    }
                    if entry.raw.starts_with(dir_path)
                        || dir_path
                            .starts_with(entry.raw.split('/').next().unwrap_or(""))
                    {
                        return true;
                    }
                }
                false
            }
        }
    }
}

// ── MutableTree ────────────────────────────────────────────────────────────

/// In-memory mutable tree node. Equivalent to TreeObject in the JS codebase.
pub struct MutableTree {
    pub hash: ObjectId,
    pub dirty: bool,
    pub children: Option<HashMap<String, Child>>,
}

pub enum Child {
    Tree(MutableTree),
    Blob { mode: u16, hash: ObjectId },
    Commit { hash: ObjectId },
    Deleted,
}

impl MutableTree {
    pub fn new(hash: ObjectId) -> Self {
        MutableTree {
            hash,
            dirty: false,
            children: None,
        }
    }

    pub fn empty() -> Self {
        MutableTree {
            hash: empty_tree_id(),
            dirty: false,
            children: Some(HashMap::new()),
        }
    }

    /// Load children from git if not already loaded.
    /// Reads the tree object directly from the ODB — no subprocess.
    pub fn ensure_children(&mut self, repo: &gix::Repository) -> Result<()> {
        if self.children.is_some() {
            return Ok(());
        }

        if self.hash == empty_tree_id() {
            self.children = Some(HashMap::new());
            return Ok(());
        }

        // Check module-level cache first
        let entries = if let Some(cached) = cache_read(&self.hash) {
            cached
        } else {
            // Read tree directly from packfile/loose object via gix
            let tree_obj = repo
                .find_object(self.hash)
                .with_context(|| format!("failed to read tree {}", self.hash))?;
            let tree_ref = tree_obj
                .try_into_tree()
                .context("object is not a tree")?;

            TREES_READ.fetch_add(1, Ordering::Relaxed);

            let entries: Vec<TreeEntry> = tree_ref
                .iter()
                .map(|entry_result| {
                    let entry = entry_result?;
                    Ok(TreeEntry {
                        name: entry
                            .filename()
                            .to_str()
                            .unwrap_or(&String::from_utf8_lossy(entry.filename().as_ref()))
                            .to_owned(),
                        entry_type: EntryType::from_kind(entry.mode().kind()),
                        mode: entry.mode().value(),
                        hash: entry.oid().to_owned(),
                    })
                })
                .collect::<Result<Vec<_>>>()?;

            cache_write(self.hash, entries.clone());
            entries
        };

        // Build children map
        let mut children = HashMap::with_capacity(entries.len());
        for entry in entries {
            let child = match entry.entry_type {
                EntryType::Tree => Child::Tree(MutableTree::new(entry.hash)),
                EntryType::Blob => Child::Blob {
                    mode: entry.mode,
                    hash: entry.hash,
                },
                EntryType::Commit => Child::Commit { hash: entry.hash },
            };
            children.insert(entry.name, child);
        }

        self.children = Some(children);
        Ok(())
    }

    /// Navigate to or create a subtree at the given path.
    pub fn get_or_create_subtree(
        &mut self,
        repo: &gix::Repository,
        path: &str,
    ) -> Result<&mut MutableTree> {
        if path == "." || path.is_empty() {
            return Ok(self);
        }

        let parts: Vec<&str> = path.split('/').collect();
        let mut current = self;

        for part in parts {
            current.ensure_children(repo)?;
            let children = current.children.as_mut().unwrap();

            let child = children
                .entry(part.to_string())
                .or_insert_with(|| Child::Tree(MutableTree::empty()));

            current = match child {
                Child::Tree(ref mut t) => t,
                _ => bail!("path component '{part}' exists but is not a tree"),
            };
        }

        Ok(current)
    }

    /// Navigate to a subtree, returning None if it doesn't exist.
    pub fn get_subtree(
        &mut self,
        repo: &gix::Repository,
        path: &str,
    ) -> Result<Option<&mut MutableTree>> {
        if path == "." || path.is_empty() {
            return Ok(Some(self));
        }

        let parts: Vec<&str> = path.split('/').collect();
        let mut current = self;

        for part in parts {
            current.ensure_children(repo)?;
            let children = current.children.as_mut().unwrap();

            match children.get_mut(part) {
                Some(Child::Tree(ref mut t)) => current = t,
                _ => return Ok(None),
            }
        }

        Ok(Some(current))
    }

    /// Get a blob's content by navigating a path in this tree.
    pub fn read_blob(&mut self, repo: &gix::Repository, path: &str) -> Result<Option<Vec<u8>>> {
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
        let children = tree.children.as_ref().unwrap();

        match children.get(file) {
            Some(Child::Blob { hash, .. }) => {
                BLOBS_READ.fetch_add(1, Ordering::Relaxed);
                let obj = repo.find_object(*hash)?;
                Ok(Some(obj.data.to_vec()))
            }
            _ => Ok(None),
        }
    }

    /// Delete a child by name.
    pub fn delete_child(&mut self, repo: &gix::Repository, name: &str) -> Result<bool> {
        self.ensure_children(repo)?;
        let children = self.children.as_mut().unwrap();
        if children.remove(name).is_some() {
            self.dirty = true;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Merge another tree into this one, following the same algorithm as
    /// TreeObject.merge() in the JS codebase.
    ///
    /// This is THE hot path — the inner loop of projection.
    pub fn merge(
        &mut self,
        repo: &gix::Repository,
        input: &mut MutableTree,
        options: &MergeOptions,
        base_path: &str,
    ) -> Result<()> {
        self.ensure_children(repo)?;
        input.ensure_children(repo)?;

        // Collect input child names to iterate (avoid borrow conflict)
        let input_names: Vec<String> = input
            .children
            .as_ref()
            .unwrap()
            .keys()
            .cloned()
            .collect();

        for child_name in &input_names {
            let input_children = input.children.as_ref().unwrap();
            let input_child = match input_children.get(child_name) {
                Some(c) => c,
                None => continue,
            };

            // Skip if hashes match (clean on both sides)
            let self_children = self.children.as_ref().unwrap();
            if let Some(base_child) = self_children.get(child_name) {
                if child_hash(base_child) == child_hash(input_child)
                    && !child_is_dirty(base_child)
                    && !child_is_dirty(input_child)
                {
                    continue;
                }
            }

            let is_input_tree = matches!(input_child, Child::Tree(_));
            let child_path = if base_path == "." {
                if is_input_tree {
                    format!("{child_name}/")
                } else {
                    child_name.clone()
                }
            } else if is_input_tree {
                format!("{base_path}{child_name}/")
            } else {
                format!("{base_path}{child_name}")
            };

            // Check glob patterns
            let mut pending_child_match = false;
            if options.has_patterns() {
                let (matched, negation_excluded) = options.matches(&child_path);

                if negation_excluded {
                    continue;
                }

                if !matched && !is_input_tree {
                    continue;
                }

                if !matched && is_input_tree {
                    if options.might_match_children(&child_path) {
                        pending_child_match = true;
                    } else {
                        continue;
                    }
                }

                if ((!matched || options.has_negations()) && is_input_tree) {
                    pending_child_match = true;
                }
            }

            // Handle non-tree (blob/commit) input
            if !is_input_tree {
                let should_write = match options.mode {
                    MergeMode::Underlay => {
                        !self.children.as_ref().unwrap().contains_key(child_name)
                    }
                    MergeMode::Overlay | MergeMode::Replace => true,
                };

                if should_write {
                    let cloned = clone_child(input_child);
                    self.children
                        .as_mut()
                        .unwrap()
                        .insert(child_name.clone(), cloned);
                    self.dirty = true;
                }
                continue;
            }

            // Input is a tree — need to merge recursively
            let has_base_tree = matches!(
                self.children.as_ref().unwrap().get(child_name),
                Some(Child::Tree(_))
            );

            if !has_base_tree || options.mode == MergeMode::Replace {
                if pending_child_match {
                    let mut temp = MutableTree::empty();
                    let input_tree =
                        match input.children.as_mut().unwrap().get_mut(child_name) {
                            Some(Child::Tree(t)) => t,
                            _ => unreachable!(),
                        };
                    temp.merge(repo, input_tree, options, &child_path)?;
                    if temp.dirty {
                        self.children
                            .as_mut()
                            .unwrap()
                            .insert(child_name.clone(), Child::Tree(temp));
                        self.dirty = true;
                    }
                    continue;
                }

                let input_child_ref =
                    input.children.as_ref().unwrap().get(child_name).unwrap();
                if !child_is_dirty(input_child_ref) {
                    let hash = child_hash(input_child_ref).unwrap();
                    self.children.as_mut().unwrap().insert(
                        child_name.clone(),
                        Child::Tree(MutableTree::new(hash)),
                    );
                    self.dirty = true;
                    continue;
                }

                let input_tree =
                    match input.children.as_mut().unwrap().get_mut(child_name) {
                        Some(Child::Tree(t)) => t,
                        _ => unreachable!(),
                    };
                let mut new_base = MutableTree::empty();
                new_base.merge(repo, input_tree, options, &child_path)?;
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

            let base_tree = match self.children.as_mut().unwrap().get_mut(child_name) {
                Some(Child::Tree(ref mut t)) => t,
                _ => unreachable!(),
            };

            base_tree.merge(repo, &mut input_tree, options, &child_path)?;

            if base_tree.dirty {
                self.dirty = true;
            }

            // Put input tree back
            input
                .children
                .as_mut()
                .unwrap()
                .insert(child_name.clone(), Child::Tree(input_tree));
        }

        // Replace mode: clear children not present in input
        if options.mode == MergeMode::Replace {
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

    /// Write this tree (and dirty subtrees) to the git ODB.
    /// Returns the hash of the written tree.
    pub fn write(&mut self, repo: &gix::Repository) -> Result<ObjectId> {
        if !self.dirty {
            TREES_SKIPPED_CLEAN.fetch_add(1, Ordering::Relaxed);
            return Ok(self.hash);
        }

        if self.children.is_none() {
            self.ensure_children(repo)?;
        }

        let children = self.children.as_mut().unwrap();

        // Recursively write dirty child trees first
        let child_names: Vec<String> = children.keys().cloned().collect();
        for name in &child_names {
            if let Some(Child::Tree(ref mut child_tree)) = children.get_mut(name) {
                if child_tree.dirty {
                    child_tree.write(repo)?;
                }
            }
        }

        // Build gix tree entries
        let mut entries: Vec<GixEntry> = Vec::new();

        for (name, child) in children.iter() {
            match child {
                Child::Deleted => continue,
                Child::Tree(t) => {
                    if t.hash == empty_tree_id() {
                        continue;
                    }
                    entries.push(GixEntry {
                        mode: EntryMode::try_from(0o040000u32).unwrap(),
                        filename: name.as_str().into(),
                        oid: t.hash,
                    });
                }
                Child::Blob { mode, hash } => {
                    entries.push(GixEntry {
                        mode: EntryMode::try_from(*mode as u32).unwrap(),
                        filename: name.as_str().into(),
                        oid: *hash,
                    });
                }
                Child::Commit { hash } => {
                    entries.push(GixEntry {
                        mode: EntryMode::try_from(0o160000u32).unwrap(),
                        filename: name.as_str().into(),
                        oid: *hash,
                    });
                }
            }
        }

        if entries.is_empty() {
            self.hash = empty_tree_id();
            self.dirty = false;
            return Ok(self.hash);
        }

        // Sort entries (git requires specific sort order)
        entries.sort();

        // Write via gix's write_object which handles Tree serialization
        let gix_tree = GixTree { entries };
        let id = repo.write_object(&gix_tree)?;

        TREES_WRITTEN.fetch_add(1, Ordering::Relaxed);

        self.hash = id.detach();
        self.dirty = false;
        Ok(self.hash)
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn child_hash(child: &Child) -> Option<ObjectId> {
    match child {
        Child::Tree(t) => Some(t.hash),
        Child::Blob { hash, .. } => Some(*hash),
        Child::Commit { hash } => Some(*hash),
        Child::Deleted => None,
    }
}

fn child_is_dirty(child: &Child) -> bool {
    match child {
        Child::Tree(t) => t.dirty,
        _ => false,
    }
}

fn clone_child(child: &Child) -> Child {
    match child {
        Child::Tree(t) => Child::Tree(MutableTree::new(t.hash)),
        Child::Blob { mode, hash } => Child::Blob {
            mode: *mode,
            hash: *hash,
        },
        Child::Commit { hash } => Child::Commit { hash: *hash },
        Child::Deleted => Child::Deleted,
    }
}
