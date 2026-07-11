//! Regression: writing a child into a subtree that already exists in the
//! parent commit must load that subtree's existing children (preserving
//! siblings) rather than panic on `children.as_mut().unwrap()`.
//!
//! Surfaced by the gitsheets holo-tree spike (JarvusInnovations/gitsheets#127):
//! every upsert into an already-populated sheet directory hit this. Before the
//! fix, `get_or_create_subtree` left the final (lazily-loaded) node's
//! `children` as `None`, so `write_child_bytes` panicked — aborting the host
//! process when called across the napi FFI boundary.

mod helpers;

use helpers::Sandbox;
use holo_tree::MutableTree;

#[test]
fn write_child_into_existing_subtree_preserves_siblings() {
    let sb = Sandbox::new();

    // A committed tree that already contains data/a.toml.
    let base = sb.write_tree(&[("data/a.toml", "id = 1\n")]);

    // Load it lazily and write a sibling into the existing data/ directory.
    let mut tree = MutableTree::new(base);
    tree.write_child(&sb.ctx(), "data/b.toml", "id = 2\n").unwrap();
    let new_hash = tree.write(&sb.ctx()).unwrap();
    assert_ne!(new_hash, base, "writing a child must change the tree hash");

    // Round-trip through the ODB: both records are present.
    let mut reloaded = MutableTree::new(new_hash);
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "data/a.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
        "existing sibling must be preserved",
    );
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "data/b.toml").unwrap().as_deref(),
        Some(&b"id = 2\n"[..]),
        "newly written child must be present",
    );
}

#[test]
fn write_child_into_fresh_subtree_still_works() {
    let sb = Sandbox::new();

    // Empty starting point — the subtree is created fresh.
    let mut tree = MutableTree::empty();
    tree.write_child(&sb.ctx(), "data/only.toml", "id = 1\n").unwrap();
    let hash = tree.write(&sb.ctx()).unwrap();

    let mut reloaded = MutableTree::new(hash);
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "data/only.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
    );
}

/// Regression: writing a file at the REPO ROOT (dir = ".") into a lazily-loaded
/// tree must load the root's children rather than panic on
/// `children.as_mut().unwrap()`. The earlier fix only covered deep paths; the
/// `path == "."` early-return in get_or_create_subtree bypassed it. Surfaced by
/// install-testing the published binding with a root-level `writeChild`.
#[test]
fn write_child_at_repo_root_preserves_siblings() {
    let sb = Sandbox::new();

    // Committed tree with a root-level file; reload it lazily (children: None).
    let base = sb.write_tree(&[("existing.toml", "id = 0\n")]);
    let mut tree = MutableTree::new(base);

    tree.write_child(&sb.ctx(), "new.toml", "id = 1\n").unwrap();
    let hash = tree.write(&sb.ctx()).unwrap();
    assert_ne!(hash, base, "a root-level write must change the tree hash");

    let mut reloaded = MutableTree::new(hash);
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "existing.toml").unwrap().as_deref(),
        Some(&b"id = 0\n"[..]),
        "existing root sibling must be preserved",
    );
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "new.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
    );
}

#[test]
fn write_child_at_repo_root_into_empty() {
    let sb = Sandbox::new();
    let mut tree = MutableTree::empty();
    tree.write_child(&sb.ctx(), "only.toml", "id = 1\n").unwrap();
    let hash = tree.write(&sb.ctx()).unwrap();

    let mut reloaded = MutableTree::new(hash);
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "only.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
    );
}

/// Regression: deleting a child deep inside a lazily-loaded tree must dirty the
/// ancestor chain, or `write()` short-circuits on a clean root and silently
/// drops the deletion (returns the original tree hash). Surfaced by the
/// gitsheets migration (#127): every Sheet delete/rename-cleanup hit this once
/// the working tree was binding-backed.
#[test]
fn delete_child_deep_into_existing_tree_persists() {
    let sb = Sandbox::new();

    // Committed tree with two records in a directory; reload it lazily.
    let base = sb.write_tree(&[("data/a.toml", "id = 1\n"), ("data/b.toml", "id = 2\n")]);
    let mut tree = MutableTree::new(base);

    let deleted = tree.delete_child_deep(&sb.ctx(), "data/a.toml").unwrap();
    assert!(deleted, "the record existed and should report deleted");

    let new_hash = tree.write(&sb.ctx()).unwrap();
    assert_ne!(new_hash, base, "deletion must change the tree hash (the bug: it didn't)");

    let mut reloaded = MutableTree::new(new_hash);
    assert!(
        reloaded.read_blob(&sb.ctx(), "data/a.toml").unwrap().is_none(),
        "deleted record must be gone after write()",
    );
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "data/b.toml").unwrap().as_deref(),
        Some(&b"id = 2\n"[..]),
        "sibling must be preserved",
    );
}

/// Deleting a non-existent deep path is a clean no-op: returns false and leaves
/// the tree hash unchanged.
#[test]
fn delete_child_deep_missing_is_noop() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[("data/a.toml", "id = 1\n")]);
    let mut tree = MutableTree::new(base);

    assert!(!tree.delete_child_deep(&sb.ctx(), "data/missing.toml").unwrap());
    assert_eq!(tree.write(&sb.ctx()).unwrap(), base, "no-op delete must not change the hash");
}

// ── write_child_hash (#477): place an existing blob by hash ─────────────────

/// Placing a blob by hash yields a byte-identical tree to writing the same
/// content via `write_child_bytes` — the whole point is to skip re-hashing while
/// producing exactly the same result.
#[test]
fn write_child_hash_matches_write_child_bytes() {
    let sb = Sandbox::new();
    let content = b"attachment payload\n";
    let blob = sb.repo.write_blob(content).unwrap().detach();

    let mut by_bytes = MutableTree::empty();
    by_bytes
        .write_child_bytes(&sb.ctx(), "data/att.bin", content)
        .unwrap();
    let bytes_hash = by_bytes.write(&sb.ctx()).unwrap();

    let mut by_hash = MutableTree::empty();
    by_hash
        .write_child_hash(&sb.ctx(), "data/att.bin", blob, 0o100644)
        .unwrap();
    let hash_hash = by_hash.write(&sb.ctx()).unwrap();

    assert_eq!(
        hash_hash, bytes_hash,
        "place-by-hash must produce the same tree as write-by-content",
    );
}

/// Placing a blob by hash into an already-populated, lazily-loaded subtree
/// preserves the existing siblings (same subtree-loading path as
/// `write_child_bytes`).
#[test]
fn write_child_hash_preserves_siblings() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[("data/a.toml", "id = 1\n")]);
    let blob = sb.repo.write_blob(b"id = 2\n").unwrap().detach();

    let mut tree = MutableTree::new(base);
    tree.write_child_hash(&sb.ctx(), "data/b.toml", blob, 0o100644)
        .unwrap();
    let new_hash = tree.write(&sb.ctx()).unwrap();
    assert_ne!(new_hash, base);

    let mut reloaded = MutableTree::new(new_hash);
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "data/a.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
        "existing sibling must be preserved",
    );
    assert_eq!(
        reloaded.read_blob(&sb.ctx(), "data/b.toml").unwrap().as_deref(),
        Some(&b"id = 2\n"[..]),
        "placed-by-hash blob must be present",
    );
}

/// The `mode` argument is honored — placing the same blob as executable records
/// mode 100755, producing a different tree than the regular-mode placement.
#[test]
fn write_child_hash_honors_executable_mode() {
    let sb = Sandbox::new();
    let blob = sb.repo.write_blob(b"#!/bin/sh\n").unwrap().detach();

    let mut regular = MutableTree::empty();
    regular
        .write_child_hash(&sb.ctx(), "run", blob, 0o100644)
        .unwrap();
    let regular_hash = regular.write(&sb.ctx()).unwrap();

    let mut exec = MutableTree::empty();
    exec.write_child_hash(&sb.ctx(), "run", blob, 0o100755)
        .unwrap();
    let exec_hash = exec.write(&sb.ctx()).unwrap();

    assert_ne!(
        regular_hash, exec_hash,
        "executable mode must be reflected in the tree entry",
    );
}

/// A hash that isn't in the ODB is rejected — no invalid entry is grafted.
#[test]
fn write_child_hash_rejects_missing_object() {
    let sb = Sandbox::new();
    // A valid-shaped sha1 that was never written to this repo's ODB.
    let absent: gix::ObjectId = "0123456789abcdef0123456789abcdef01234567"
        .parse()
        .unwrap();

    let mut tree = MutableTree::empty();
    let err = tree
        .write_child_hash(&sb.ctx(), "x", absent, 0o100644)
        .unwrap_err();
    // Per specs/api/errors.md: assert the stable code, never message text.
    assert_eq!(err.code(), "OBJECT_NOT_FOUND", "got {err:?}");
}

/// A hash pointing at a non-blob object (here a tree) is rejected rather than
/// silently producing a tree entry that claims a blob mode over a tree object.
#[test]
fn write_child_hash_rejects_non_blob() {
    let sb = Sandbox::new();
    let tree_oid = sb.write_tree(&[("inner.toml", "id = 1\n")]);

    let mut tree = MutableTree::empty();
    let err = tree
        .write_child_hash(&sb.ctx(), "x", tree_oid, 0o100644)
        .unwrap_err();
    // Wrong object kind is a caller error: INVALID_ARGUMENT (not message prose).
    assert_eq!(err.code(), "INVALID_ARGUMENT", "got {err:?}");
}

/// An invalid (non-blob) mode is rejected up front, before any tree mutation —
/// it would otherwise panic later in `write()` when mapped to an `EntryMode`.
#[test]
fn write_child_hash_rejects_invalid_mode() {
    let sb = Sandbox::new();
    let blob = sb.repo.write_blob(b"x\n").unwrap().detach();

    let mut tree = MutableTree::empty();
    // 040000 is a tree mode, not valid for a blob entry.
    let err = tree
        .write_child_hash(&sb.ctx(), "x", blob, 0o040000)
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGUMENT", "got {err:?}");
    // The tree must be untouched by a rejected call.
    assert_eq!(
        tree.write(&sb.ctx()).unwrap(),
        MutableTree::empty().write(&sb.ctx()).unwrap(),
        "a rejected write_child_hash must not mutate the tree",
    );
}
