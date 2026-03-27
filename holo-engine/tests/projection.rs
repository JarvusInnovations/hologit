//! End-to-end projection integration tests.

mod helpers;

use helpers::*;
use holo_engine::tree::MutableTree;

fn list_tree(repo: &gix::Repository, hash: gix::ObjectId) -> Vec<String> {
    let mut tree = MutableTree::new(hash);
    collect_paths(repo, &mut tree, "")
}

fn collect_paths(repo: &gix::Repository, tree: &mut MutableTree, prefix: &str) -> Vec<String> {
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

fn read_blob(repo: &gix::Repository, hash: gix::ObjectId, path: &str) -> String {
    let mut tree = MutableTree::new(hash);
    let data = tree.read_blob(repo, path).unwrap().unwrap();
    String::from_utf8(data).unwrap()
}

// ── Simple self-source projection ──────────────────────────────────────────

#[test]
fn project_self_source_all_files() {
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
            ("index.html".into(), "<html>".into()),
            ("style.css".into(), "body{}".into()),
        ],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"index.html".to_string()));
    assert!(paths.contains(&"style.css".to_string()));
    // .holo should be stripped
    assert!(!paths.iter().any(|p| p.starts_with(".holo")));
}

#[test]
fn project_self_source_with_glob_filter() {
    let sb = Sandbox::new();

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_myapp".into(), MappingSpec {
                files: vec!["docs/".to_string(), "mkdocs.yml".to_string()],
                ..Default::default()
            })],
            ..Default::default()
        })],
        files: vec![
            ("docs/guide.md".into(), "# Guide".into()),
            ("mkdocs.yml".into(), "site_name: test".into()),
            ("src/app.js".into(), "//excluded".into()),
        ],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"docs/guide.md".to_string()));
    assert!(paths.contains(&"mkdocs.yml".to_string()));
    assert!(!paths.contains(&"src/app.js".to_string()));
}

#[test]
fn project_self_source_with_negation() {
    let sb = Sandbox::new();

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_myapp".into(), MappingSpec {
                files: vec![
                    "*/**".to_string(),
                    "!.github/".to_string(),
                    "!node_modules/".to_string(),
                ],
                ..Default::default()
            })],
            ..Default::default()
        })],
        files: vec![
            ("src/app.js".into(), "keep".into()),
            (".github/ci.yml".into(), "exclude".into()),
            ("node_modules/pkg/index.js".into(), "exclude".into()),
        ],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"src/app.js".to_string()));
    assert!(!paths.iter().any(|p| p.starts_with(".github")));
    assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
}

// ── Multi-source with gitlinks ─────────────────────────────────────────────

#[test]
fn project_two_sources_via_gitlinks() {
    let sb = Sandbox::new();

    // Create source A tree + commit
    let source_a_tree = sb.write_tree(&[("a.txt", "from A")]);
    let source_a_commit = sb.commit(source_a_tree, None, "source A");

    // Create source B tree + commit
    let source_b_tree = sb.write_tree(&[("b.txt", "from B")]);
    let source_b_commit = sb.commit(source_b_tree, None, "source B");

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "composed".into(),
        sources: vec![
            ("source-a".into(), SourceSpec::default()),
            ("source-b".into(), SourceSpec::default()),
        ],
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![
                ("_source-a".into(), MappingSpec::default()),
                ("_source-b".into(), MappingSpec {
                    after: vec!["source-a".to_string()],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        })],
        gitlinks: vec![
            ("source-a".into(), source_a_commit),
            ("source-b".into(), source_b_commit),
        ],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"a.txt".to_string()));
    assert!(paths.contains(&"b.txt".to_string()));
    assert_eq!(read_blob(&sb.repo, result, "a.txt"), "from A");
    assert_eq!(read_blob(&sb.repo, result, "b.txt"), "from B");
}

// ── Mapping root and output paths ──────────────────────────────────────────

#[test]
fn project_with_root_path() {
    let sb = Sandbox::new();

    // Source tree has files under src/lib/
    let source_tree = sb.write_tree(&[
        ("src/lib/util.js", "util"),
        ("src/lib/core.js", "core"),
        ("README.md", "readme"),
    ]);
    let source_commit = sb.commit(source_tree, None, "source");

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        sources: vec![("mylib".into(), SourceSpec::default())],
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("mylib".into(), MappingSpec {
                files: vec!["**".to_string()],
                root: Some("src/lib".into()),
                ..Default::default()
            })],
            ..Default::default()
        })],
        gitlinks: vec![("mylib".into(), source_commit)],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    // Files from src/lib/ should appear at /mylib/ (default output = mapping name)
    assert!(paths.contains(&"mylib/util.js".to_string()));
    assert!(paths.contains(&"mylib/core.js".to_string()));
    // README.md is outside root, should not appear
    assert!(!paths.contains(&"README.md".to_string()));
}

// ── Branch extends ─────────────────────────────────────────────────────────

#[test]
fn project_branch_extends_chain() {
    let sb = Sandbox::new();

    // Source with files
    let source_tree = sb.write_tree(&[
        ("base.txt", "from base"),
        ("override.txt", "from base"),
    ]);
    let source_commit = sb.commit(source_tree, None, "source");

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "outer".into(),
        sources: vec![("content".into(), SourceSpec::default())],
        branches: vec![
            // Base branch
            ("base".into(), BranchSpec {
                mappings: vec![("_content".into(), MappingSpec::default())],
                ..Default::default()
            }),
            // Extended branch with no extra mappings but different config
            ("extended".into(), BranchSpec {
                extend: Some("base".into()),
                lens: Some(false),
                ..Default::default()
            }),
        ],
        gitlinks: vec![("content".into(), source_commit)],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "extended").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"base.txt".to_string()));
    assert!(paths.contains(&"override.txt".to_string()));
}

// ── Recursive projection via gitlink + project.holobranch ──────────────────

#[test]
fn project_source_with_inner_projection() {
    let sb = Sandbox::new();

    // Build an inner workspace (the "library" source)
    // It has its own .holo/ config with a holobranch that filters files
    let inner_root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "library".into(),
        branches: vec![("dist".into(), BranchSpec {
            mappings: vec![("_library".into(), MappingSpec {
                files: vec!["lib/".to_string()],
                ..Default::default()
            })],
            ..Default::default()
        })],
        files: vec![
            ("lib/core.js".into(), "core".into()),
            ("test/core.test.js".into(), "test-excluded".into()),
            ("README.md".into(), "readme-excluded".into()),
        ],
        ..Default::default()
    });
    let inner_commit = sb.commit(inner_root, None, "library v1");

    // Build the outer workspace that uses the library as a projected source
    let outer_root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        sources: vec![("library".into(), SourceSpec {
            project_holobranch: Some("dist".into()),
            ..Default::default()
        })],
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_library".into(), MappingSpec::default())],
            ..Default::default()
        })],
        gitlinks: vec![("library".into(), inner_commit)],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, outer_root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"lib/core.js".to_string()));
    // Inner projection should have filtered these out
    assert!(!paths.contains(&"test/core.test.js".to_string()));
    assert!(!paths.contains(&"README.md".to_string()));
}

// ── Metadata stripping ─────────────────────────────────────────────────────

#[test]
fn strips_holo_branches_and_sources() {
    let sb = Sandbox::new();

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_app".into(), MappingSpec::default())],
            ..Default::default()
        })],
        files: vec![("index.html".into(), "<html>".into())],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(!paths.iter().any(|p| p.starts_with(".holo/branches")));
    assert!(!paths.iter().any(|p| p.starts_with(".holo/sources")));
}

#[test]
fn strips_holo_entirely_when_only_config_remains() {
    let sb = Sandbox::new();

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_app".into(), MappingSpec::default())],
            ..Default::default()
        })],
        files: vec![("file.txt".into(), "content".into())],
        ..Default::default()
    });

    holo_engine::reset();
    let result = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(!paths.iter().any(|p| p.starts_with(".holo")),
        ".holo should be stripped entirely when only config.toml remains. Got: {:?}",
        paths.iter().filter(|p| p.starts_with(".holo")).collect::<Vec<_>>());
}

// ── Plan builder API ───────────────────────────────────────────────────────

#[test]
fn project_plan_single_source() {
    let sb = Sandbox::new();

    let source_tree = sb.write_tree(&[("app.js", "code"), ("style.css", "css")]);
    let source_commit = sb.commit(source_tree, None, "v1");

    // Store commit at a ref that source resolution can find
    sb.set_ref("refs/heads/main", source_commit);

    holo_engine::reset();
    let result = holo_engine::project_plan(
        &sb.repo,
        &[holo_engine::PlanSource {
            name: "frontend".into(),
            url: None,
            git_ref: Some("refs/heads/main".into()),
            project_holobranch: None,
        }],
        &[holo_engine::PlanMapping::new("frontend")],
    )
    .unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"app.js".to_string()));
    assert!(paths.contains(&"style.css".to_string()));
}

#[test]
fn project_plan_two_layers_with_ordering() {
    let sb = Sandbox::new();

    let base_tree = sb.write_tree(&[("file.txt", "base"), ("base-only.txt", "base")]);
    let base_commit = sb.commit(base_tree, None, "base");
    sb.set_ref("refs/heads/base", base_commit);

    let overlay_tree = sb.write_tree(&[("file.txt", "overlay"), ("overlay-only.txt", "overlay")]);
    let overlay_commit = sb.commit(overlay_tree, None, "overlay");
    sb.set_ref("refs/heads/overlay", overlay_commit);

    holo_engine::reset();
    let result = holo_engine::project_plan(
        &sb.repo,
        &[
            holo_engine::PlanSource {
                name: "base".into(),
                url: None,
                git_ref: Some("refs/heads/base".into()),
                project_holobranch: None,
            },
            holo_engine::PlanSource {
                name: "overlay".into(),
                url: None,
                git_ref: Some("refs/heads/overlay".into()),
                project_holobranch: None,
            },
        ],
        &[
            holo_engine::PlanMapping::new("base"),
            holo_engine::PlanMapping {
                after: vec!["base".to_string()],
                ..holo_engine::PlanMapping::new("overlay")
            },
        ],
    )
    .unwrap();

    let paths = list_tree(&sb.repo, result);
    assert!(paths.contains(&"base-only.txt".to_string()));
    assert!(paths.contains(&"overlay-only.txt".to_string()));
    // Overlay wins on shared file
    assert_eq!(read_blob(&sb.repo, result, "file.txt"), "overlay");
}

// ── Hash stability ─────────────────────────────────────────────────────────

#[test]
fn same_input_produces_same_hash() {
    let sb = Sandbox::new();

    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        branches: vec![("site".into(), BranchSpec {
            mappings: vec![("_app".into(), MappingSpec::default())],
            ..Default::default()
        })],
        files: vec![("file.txt".into(), "content".into())],
        ..Default::default()
    });

    holo_engine::reset();
    let hash1 = holo_engine::project_branch(&sb.repo, root, "site").unwrap();
    holo_engine::reset();
    let hash2 = holo_engine::project_branch(&sb.repo, root, "site").unwrap();

    assert_eq!(hash1, hash2, "identical input must produce identical hash");
}
