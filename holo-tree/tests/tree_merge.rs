//! Integration tests for tree merge — the hot path.

mod helpers;

use helpers::Sandbox;
use holo_tree::tree::{MergeMode, MergeOptions, MutableTree};

fn list_tree(repo: &gix::Repository, hash: gix::ObjectId) -> Vec<String> {
    let mut tree = MutableTree::new(hash);
    collect_paths(repo, &mut tree, "")
}

fn collect_paths(repo: &gix::Repository, tree: &mut MutableTree, prefix: &str) -> Vec<String> {
    tree.ensure_children(repo).unwrap();
    let mut paths = Vec::new();
    // snapshot keys to avoid borrow issues
    let keys: Vec<String> = tree.children.as_ref().unwrap().keys().cloned().collect();
    for name in keys {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        match tree.children.as_mut().unwrap().get_mut(&name) {
            Some(holo_tree::tree::Child::Tree(ref mut t)) => {
                paths.extend(collect_paths(repo, t, &path));
            }
            Some(holo_tree::tree::Child::Blob { .. }) => paths.push(path),
            Some(holo_tree::tree::Child::Commit { .. }) => paths.push(format!("{path} [gitlink]")),
            None => {}
        }
    }
    paths
}

fn read_blob(repo: &gix::Repository, hash: gix::ObjectId, path: &str) -> String {
    let mut tree = MutableTree::new(hash);
    let data = tree.read_blob(repo, path).unwrap().unwrap();
    String::from_utf8(data).unwrap()
}

// ── Overlay mode ───────────────────────────────────────────────────────────

#[test]
fn overlay_overwrites_existing_files() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("file.txt", "original")]);
    let source_hash = sb.write_tree(&[("file.txt", "updated")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    assert_eq!(read_blob(&sb.repo, result, "file.txt"), "updated");
}

#[test]
fn overlay_preserves_non_overlapping_files() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("keep.txt", "kept"), ("shared.txt", "v1")]);
    let source_hash = sb.write_tree(&[("shared.txt", "v2")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let files = list_tree(&sb.repo, result);
    assert!(files.contains(&"keep.txt".to_string()));
    assert!(files.contains(&"shared.txt".to_string()));
    assert_eq!(read_blob(&sb.repo, result, "keep.txt"), "kept");
    assert_eq!(read_blob(&sb.repo, result, "shared.txt"), "v2");
}

#[test]
fn overlay_adds_new_files() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("a.txt", "a")]);
    let source_hash = sb.write_tree(&[("b.txt", "b")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let files = list_tree(&sb.repo, result);
    assert!(files.contains(&"a.txt".to_string()));
    assert!(files.contains(&"b.txt".to_string()));
}

#[test]
fn overlay_merges_nested_directories() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("a/b/file1.txt", "f1")]);
    let source_hash = sb.write_tree(&[("a/b/file2.txt", "f2"), ("a/c/file3.txt", "f3")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let files = list_tree(&sb.repo, result);
    assert!(files.contains(&"a/b/file1.txt".to_string()));
    assert!(files.contains(&"a/b/file2.txt".to_string()));
    assert!(files.contains(&"a/c/file3.txt".to_string()));
}

// ── Replace mode ───────────────────────────────────────────────────────────

#[test]
fn replace_removes_unmatched_target_children() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("remove.txt", "gone"), ("shared.txt", "v1")]);
    let source_hash = sb.write_tree(&[("shared.txt", "v2")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Replace).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let files = list_tree(&sb.repo, result);
    assert!(!files.contains(&"remove.txt".to_string()));
    assert!(files.contains(&"shared.txt".to_string()));
}

// ── Underlay mode ──────────────────────────────────────────────────────────

#[test]
fn underlay_does_not_overwrite_existing() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("file.txt", "original")]);
    let source_hash = sb.write_tree(&[("file.txt", "should not appear")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Underlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    assert_eq!(read_blob(&sb.repo, result, "file.txt"), "original");
}

#[test]
fn underlay_fills_gaps() {
    let sb = Sandbox::new();
    let target_hash = sb.write_tree(&[("existing.txt", "exists")]);
    let source_hash = sb.write_tree(&[("new.txt", "from source")]);

    let mut target = MutableTree::new(target_hash);
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Underlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let files = list_tree(&sb.repo, result);
    assert!(files.contains(&"existing.txt".to_string()));
    assert!(files.contains(&"new.txt".to_string()));
}

// ── Glob filtering ─────────────────────────────────────────────────────────

#[test]
fn glob_includes_only_matching_files() {
    let sb = Sandbox::new();
    let source_hash = sb.write_tree(&[
        ("src/app.js", "js"),
        ("src/style.css", "css"),
        ("src/index.html", "html"),
    ]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let files = vec!["**/*.js".to_string()];
    let opts = MergeOptions::new(Some(&files), MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"src/app.js".to_string()));
    assert!(!paths.contains(&"src/style.css".to_string()));
    assert!(!paths.contains(&"src/index.html".to_string()));
}

#[test]
fn glob_double_star_matches_root_level() {
    // This was a key PoC bug: **/*.php must match Admin.php (zero ** segments)
    let sb = Sandbox::new();
    let source_hash = sb.write_tree(&[
        ("Admin.php", "root-level"),
        ("sub/Nested.php", "nested"),
        ("README.md", "not php"),
    ]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let files = vec!["**/*.php".to_string()];
    let opts = MergeOptions::new(Some(&files), MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"Admin.php".to_string()), "** must match zero segments");
    assert!(paths.contains(&"sub/Nested.php".to_string()));
    assert!(!paths.contains(&"README.md".to_string()));
}

#[test]
fn glob_negation_excludes_directory() {
    let sb = Sandbox::new();
    let source_hash = sb.write_tree(&[
        ("src/app.js", "keep"),
        (".github/ci.yml", "exclude"),
    ]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let files = vec!["*/**".to_string(), "!.github/".to_string()];
    let opts = MergeOptions::new(Some(&files), MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"src/app.js".to_string()));
    assert!(!paths.iter().any(|p| p.starts_with(".github")));
}

#[test]
fn glob_multiple_negations() {
    let sb = Sandbox::new();
    let source_hash = sb.write_tree(&[
        ("src/app.js", "keep"),
        (".github/ci.yml", "exclude1"),
        (".vscode/settings.json", "exclude2"),
        ("docs/readme.md", "exclude3"),
    ]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let files = vec![
        "*/**".to_string(),
        "!.github/".to_string(),
        "!.vscode/".to_string(),
        "!docs/".to_string(),
    ];
    let opts = MergeOptions::new(Some(&files), MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"src/app.js".to_string()));
    assert!(!paths.iter().any(|p| p.starts_with(".github")));
    assert!(!paths.iter().any(|p| p.starts_with(".vscode")));
    assert!(!paths.iter().any(|p| p.starts_with("docs")));
}

// ── Dirty tracking ─────────────────────────────────────────────────────────

#[test]
fn identical_merge_stays_clean() {
    let sb = Sandbox::new();
    let hash = sb.write_tree(&[("file.txt", "content")]);

    let mut target = MutableTree::new(hash);
    let mut source = MutableTree::new(hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    assert!(!target.dirty, "merging identical trees should not set dirty");
}

#[test]
fn write_resets_dirty() {
    let sb = Sandbox::new();
    let source_hash = sb.write_tree(&[("file.txt", "content")]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();
    assert!(target.dirty);

    target.write(&sb.repo).unwrap();
    assert!(!target.dirty);
}

#[test]
fn get_or_create_subtree_marks_ancestors_dirty() {
    // This was THE hardest bug to find in the PoC. Without dirty propagation,
    // subtrees created via get_or_create_subtree were silently lost.
    let sb = Sandbox::new();
    let mut tree = MutableTree::empty();
    let sub = tree.get_or_create_subtree(&sb.repo, "a/b/c").unwrap();
    // Insert a blob into the deepest subtree
    sub.children.as_mut().unwrap().insert(
        "file.txt".to_string(),
        holo_tree::tree::Child::Blob {
            mode: 0o100644,
            hash: sb.write_blob("content"),
        },
    );
    sub.dirty = true;

    assert!(tree.dirty, "root must be dirty after creating subtree path");

    let result = tree.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(
        paths.contains(&"a/b/c/file.txt".to_string()),
        "file in created subtree must survive write(). Got: {:?}",
        paths
    );
}

// ── Sequential merges ──────────────────────────────────────────────────────

#[test]
fn sequential_merges_accumulate() {
    let sb = Sandbox::new();
    let source_a = sb.write_tree(&[("a.txt", "a")]);
    let source_b = sb.write_tree(&[("b.txt", "b")]);

    let mut target = MutableTree::empty();
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();

    let mut src_a = MutableTree::new(source_a);
    target.merge(&sb.repo, &mut src_a, &opts, ".").unwrap();

    let mut src_b = MutableTree::new(source_b);
    target.merge(&sb.repo, &mut src_b, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"a.txt".to_string()));
    assert!(paths.contains(&"b.txt".to_string()));
}

// ── Edge cases ─────────────────────────────────────────────────────────────

#[test]
fn empty_into_empty_is_noop() {
    let sb = Sandbox::new();
    let mut target = MutableTree::empty();
    let mut source = MutableTree::empty();
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();
    assert!(!target.dirty);
}

#[test]
fn preserves_executable_mode() {
    let sb = Sandbox::new();
    use holo_tree::tree::Child;

    let script_hash = sb.write_blob("#!/bin/sh\necho hi");
    let source_hash = sb.write_tree_with_entries(&[helpers::TreeEntrySpec {
        name: "run.sh".into(),
        mode: 0o100755,
        hash: script_hash,
    }]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let mut check = MutableTree::new(result);
    check.ensure_children(&sb.repo).unwrap();
    match check.children.as_ref().unwrap().get("run.sh") {
        Some(Child::Blob { mode, .. }) => assert_eq!(*mode, 0o100755),
        other => panic!("expected executable blob, got {:?}", other.is_some()),
    }
}

#[test]
fn preserves_gitlink_entries() {
    let sb = Sandbox::new();
    let fake_commit = gix::ObjectId::from_hex(b"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();

    let source_hash = sb.write_tree_with_entries(&[helpers::TreeEntrySpec {
        name: "submodule".into(),
        mode: 0o160000,
        hash: fake_commit,
    }]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let mut check = MutableTree::new(result);
    check.ensure_children(&sb.repo).unwrap();
    match check.children.as_ref().unwrap().get("submodule") {
        Some(holo_tree::tree::Child::Commit { hash }) => assert_eq!(*hash, fake_commit),
        _ => panic!("expected gitlink"),
    }
}

#[test]
fn deep_nesting_20_levels() {
    let sb = Sandbox::new();
    let deep_path = (0..20)
        .map(|i| format!("d{i}"))
        .collect::<Vec<_>>()
        .join("/")
        + "/file.txt";

    let source_hash = sb.write_tree(&[(&deep_path, "deep")]);

    let mut target = MutableTree::empty();
    let mut source = MutableTree::new(source_hash);
    let opts = MergeOptions::new(None, MergeMode::Overlay).unwrap();
    target.merge(&sb.repo, &mut source, &opts, ".").unwrap();

    let result = target.write(&sb.repo).unwrap();
    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&deep_path));
}
