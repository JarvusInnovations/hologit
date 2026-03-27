//! Source resolution tests — spec hash computation, tag peeling, gitlinks.

mod helpers;

use helpers::*;

// ── Spec hash computation ──────────────────────────────────────────────────
//
// These test that the Rust spec hash matches the JS implementation.
// The known hashes were computed by running the JS code.

#[test]
fn spec_hash_https_url() {
    // JS: parse-url("https://github.com/CodeForPhilly/laddr")
    //   → host = "github.com", path = "/codeforphilly/laddr"
    let hash = holo_engine::source::compute_spec_hash("https://github.com/CodeForPhilly/laddr")
        .unwrap();
    assert_eq!(hash, "64cf84c3745210e48cfa429e13924103dcd998c4");
}

#[test]
fn spec_hash_https_with_git_suffix() {
    let hash = holo_engine::source::compute_spec_hash(
        "https://github.com/gitonomy/gitlib.git",
    )
    .unwrap();
    assert_eq!(hash, "9c40d65a6de819eb50b0d20c1965ff82fb5b7f5c");
}

#[test]
fn spec_hash_emergence_skeleton() {
    let hash = holo_engine::source::compute_spec_hash(
        "https://github.com/JarvusInnovations/emergence-skeleton",
    )
    .unwrap();
    assert_eq!(hash, "88a9a452a42d1070b1295b40e0bc10287d316b4c");
}

// ── Gitlink resolution ─────────────────────────────────────────────────────

#[test]
fn resolves_gitlink_source() {
    let sb = Sandbox::new();

    let source_tree = sb.write_tree(&[("hello.txt", "world")]);
    let source_commit = sb.commit(source_tree, None, "v1");

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        sources: vec![("dep".into(), SourceSpec::default())],
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_dep".into(), MappingSpec::default())],
            ..Default::default()
        })],
        gitlinks: vec![("dep".into(), source_commit)],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let mut tree = holo_engine::tree::MutableTree::new(result);
    let data = tree.read_blob(&sb.repo, "hello.txt").unwrap().unwrap();
    assert_eq!(std::str::from_utf8(&data).unwrap(), "world");
}

// ── Tag peeling ────────────────────────────────────────────────────────────

#[test]
fn resolves_source_through_annotated_tag() {
    let sb = Sandbox::new();

    let source_tree = sb.write_tree(&[("tagged.txt", "from tag")]);
    let source_commit = sb.commit(source_tree, None, "release");

    // Create an annotated tag pointing to the commit
    use gix::objs::Tag;
    let sig = gix::actor::SignatureRef {
        name: "Test".into(),
        email: "test@test".into(),
        time: "1700000000 +0000",
    };
    let tag = Tag {
        target: source_commit,
        target_kind: gix::objs::Kind::Commit,
        name: "v1.0.0".into(),
        tagger: Some(sig.to_owned().unwrap()),
        message: "release v1.0.0".into(),
        pgp_signature: None,
    };
    let tag_id = sb.repo.write_object(&tag).unwrap().detach();

    // Store tag at a ref
    sb.set_ref("refs/tags/v1.0.0", tag_id);

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        sources: vec![("dep".into(), SourceSpec {
            git_ref: Some("refs/tags/v1.0.0".into()),
            ..Default::default()
        })],
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_dep".into(), MappingSpec::default())],
            ..Default::default()
        })],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let mut tree = holo_engine::tree::MutableTree::new(result);
    let data = tree.read_blob(&sb.repo, "tagged.txt").unwrap().unwrap();
    assert_eq!(std::str::from_utf8(&data).unwrap(), "from tag");
}

// ── Self-source ────────────────────────────────────────────────────────────

#[test]
fn self_source_returns_workspace_tree() {
    let sb = Sandbox::new();

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_myapp".into(), MappingSpec {
                files: vec!["**".to_string()],
                ..Default::default()
            })],
            ..Default::default()
        })],
        files: vec![
            ("content.txt".into(), "self-source content".into()),
        ],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let mut tree = holo_engine::tree::MutableTree::new(result);
    let data = tree.read_blob(&sb.repo, "content.txt").unwrap().unwrap();
    assert_eq!(std::str::from_utf8(&data).unwrap(), "self-source content");
}

// ── Mapping holobranch (=> syntax) ─────────────────────────────────────────

#[test]
fn mapping_holobranch_triggers_inner_projection() {
    let sb = Sandbox::new();

    // Inner workspace with a holobranch that filters files
    let inner_root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "lib".into(),
        branches: vec![("dist".into(), BranchSpec {
            mappings: vec![("_lib".into(), MappingSpec {
                files: vec!["src/".to_string()],
                ..Default::default()
            })],
            ..Default::default()
        })],
        files: vec![
            ("src/core.js".into(), "core".into()),
            ("test/spec.js".into(), "test-excluded".into()),
        ],
        ..Default::default()
    });
    let inner_commit = sb.commit(inner_root, None, "v1");

    // Outer workspace uses lib=>dist
    let outer_root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        sources: vec![("lib".into(), SourceSpec::default())],
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_lib".into(), MappingSpec {
                holosource: Some("lib=>dist".into()),
                ..Default::default()
            })],
            ..Default::default()
        })],
        gitlinks: vec![("lib".into(), inner_commit)],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, outer_root, "site").unwrap();

    let paths = {
        let mut tree = holo_engine::tree::MutableTree::new(result);
        collect_paths(&sb.repo, &mut tree, "")
    };

    assert!(paths.contains(&"src/core.js".to_string()));
    assert!(!paths.contains(&"test/spec.js".to_string()));
}

fn collect_paths(repo: &gix::Repository, tree: &mut holo_engine::tree::MutableTree, prefix: &str) -> Vec<String> {
    tree.ensure_children(repo).unwrap();
    let mut paths = Vec::new();
    let keys: Vec<String> = tree.children.as_ref().unwrap().keys().cloned().collect();
    for name in keys {
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        match tree.children.as_mut().unwrap().get_mut(&name) {
            Some(holo_engine::tree::Child::Tree(ref mut t)) => {
                paths.extend(collect_paths(repo, t, &path));
            }
            Some(holo_engine::tree::Child::Blob { .. }) => paths.push(path),
            _ => {}
        }
    }
    paths
}
