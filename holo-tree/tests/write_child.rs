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
    tree.write_child(&sb.repo, "data/b.toml", "id = 2\n").unwrap();
    let new_hash = tree.write(&sb.repo).unwrap();
    assert_ne!(new_hash, base, "writing a child must change the tree hash");

    // Round-trip through the ODB: both records are present.
    let mut reloaded = MutableTree::new(new_hash);
    assert_eq!(
        reloaded.read_blob(&sb.repo, "data/a.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
        "existing sibling must be preserved",
    );
    assert_eq!(
        reloaded.read_blob(&sb.repo, "data/b.toml").unwrap().as_deref(),
        Some(&b"id = 2\n"[..]),
        "newly written child must be present",
    );
}

#[test]
fn write_child_into_fresh_subtree_still_works() {
    let sb = Sandbox::new();

    // Empty starting point — the subtree is created fresh.
    let mut tree = MutableTree::empty();
    tree.write_child(&sb.repo, "data/only.toml", "id = 1\n").unwrap();
    let hash = tree.write(&sb.repo).unwrap();

    let mut reloaded = MutableTree::new(hash);
    assert_eq!(
        reloaded.read_blob(&sb.repo, "data/only.toml").unwrap().as_deref(),
        Some(&b"id = 1\n"[..]),
    );
}
