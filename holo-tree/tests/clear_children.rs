//! Tests for `MutableTree::clear_children` — the O(1) subtree clear that
//! gitsheets uses to wipe a sheet directory before a full rewrite.

mod helpers;

use helpers::Sandbox;
use holo_tree::MutableTree;

fn list_tree(repo: &gix::Repository, hash: gix::ObjectId) -> Vec<String> {
    let mut tree = MutableTree::new(hash);
    let mut out = Vec::new();
    for (path, _) in tree.get_blob_map(repo).unwrap() {
        out.push(path);
    }
    out.sort();
    out
}

#[test]
fn clears_a_deep_subtree_but_preserves_siblings() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[
        ("data/widgets/1.toml", "id = 1\n"),
        ("data/widgets/2.toml", "id = 2\n"),
        ("data/gadgets/9.toml", "id = 9\n"),
        ("README.md", "hi\n"),
    ]);

    let mut tree = MutableTree::new(base);
    tree.clear_children(&sb.repo, "data/widgets").unwrap();
    let hash = tree.write(&sb.repo).unwrap();

    assert_ne!(hash, base, "clearing a populated subtree must change the hash");
    assert_eq!(
        list_tree(&sb.repo, hash),
        vec![
            "README.md".to_string(),
            "data/gadgets/9.toml".to_string(),
        ],
        "only the widgets/ subtree should be gone",
    );
}

#[test]
fn cleared_subtree_can_be_repopulated_in_the_same_pass() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[
        ("data/widgets/old-a.toml", "id = 1\n"),
        ("data/widgets/old-b.toml", "id = 2\n"),
    ]);

    let mut tree = MutableTree::new(base);
    tree.clear_children(&sb.repo, "data/widgets").unwrap();
    tree.write_child(&sb.repo, "data/widgets/new.toml", "id = 3\n")
        .unwrap();
    let hash = tree.write(&sb.repo).unwrap();

    assert_eq!(
        list_tree(&sb.repo, hash),
        vec!["data/widgets/new.toml".to_string()],
        "old entries cleared, new entry present",
    );
}

#[test]
fn clearing_the_root_yields_the_empty_tree() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[("a.toml", "1\n"), ("b/c.toml", "2\n")]);

    let mut tree = MutableTree::new(base);
    tree.clear_children(&sb.repo, ".").unwrap();
    let hash = tree.write(&sb.repo).unwrap();

    assert_eq!(
        hash,
        holo_tree::tree::empty_tree_id(),
        "clearing the root must produce git's empty tree",
    );
}

#[test]
fn clearing_a_missing_path_is_a_noop_on_write() {
    let sb = Sandbox::new();
    let base = sb.write_tree(&[("data/widgets/1.toml", "id = 1\n")]);

    let mut tree = MutableTree::new(base);
    // Path doesn't exist yet; an empty subtree is pruned on write().
    tree.clear_children(&sb.repo, "data/never").unwrap();
    let hash = tree.write(&sb.repo).unwrap();

    assert_eq!(
        hash, base,
        "clearing a non-existent subtree must not change the written tree",
    );
}
