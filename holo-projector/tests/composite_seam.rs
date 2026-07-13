//! Tests for the hybrid-CLI composition seam (`composite_branch`) and the
//! lensed-sub-projection guard (`specs/behaviors/composition.md`
//! § Sub-projection lensing).

mod helpers;

use helpers::*;
use holo_projector::holo_tree::tree::MutableTree;
use holo_projector::error::Error;

fn has_path(ctx: &holo_projector::holo_tree::Context, hash: gix::ObjectId, path: &str) -> bool {
    let mut tree = MutableTree::new(hash);
    tree.get_child(ctx, path).unwrap().is_some()
}

/// A workspace whose branch maps the whole self-source.
fn self_source_workspace(sb: &Sandbox) -> gix::ObjectId {
    sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![("_myapp".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        files: vec![("index.html".into(), "<html>".into())],
        ..Default::default()
    })
}

// ── composite_branch: the pre-lens seam ────────────────────────────────────

#[test]
fn composite_branch_keeps_holo_config_for_lens_phase() {
    let sb = Sandbox::new();
    let root = self_source_workspace(&sb);

    let pre_lens = holo_projector::composite_branch(&sb.repo, root, "site").unwrap();
    let full = holo_projector::project_branch(&sb.repo, root, "site").unwrap();

    let ctx = sb.ctx();
    // Pre-lens tree: `.holo/{branches,sources}` stripped, config.toml kept.
    assert!(has_path(&ctx, pre_lens, ".holo/config.toml"));
    assert!(!has_path(&ctx, pre_lens, ".holo/branches"));
    assert!(!has_path(&ctx, pre_lens, ".holo/sources"));
    assert!(has_path(&ctx, pre_lens, "index.html"));

    // Full projection: the bare `.holo` is stripped entirely.
    assert!(!has_path(&ctx, full, ".holo"));
    assert!(has_path(&ctx, full, "index.html"));
    assert_ne!(pre_lens, full);
}

#[test]
fn composite_branch_keeps_internal_lenses_for_lens_phase() {
    let sb = Sandbox::new();
    let root = sb.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![("_myapp".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        files: vec![
            ("index.html".into(), "<html>".into()),
            (
                ".holo/lenses/minify.toml".into(),
                "[hololens]\ncontainer = \"example/minify:latest\"\n".into(),
            ),
        ],
        ..Default::default()
    });

    let pre_lens = holo_projector::composite_branch(&sb.repo, root, "site").unwrap();

    // Top-level lensing is the host's job: internal lens configs must
    // survive composition so the host's lens phase can discover them.
    let ctx = sb.ctx();
    assert!(has_path(&ctx, pre_lens, ".holo/lenses/minify.toml"));
}

// ── Lensed sub-projection guard ────────────────────────────────────────────

/// Sub-workspace tree for `libsrc=>public` style recursion, optionally
/// carrying lens configs and an explicit branch-level lens flag.
fn sub_workspace(
    sb: &Sandbox,
    lens_flag: Option<bool>,
    external_lens: bool,
    internal_lens: bool,
) -> gix::ObjectId {
    let mut files = vec![("lib.js".into(), "export {}".into())];
    if external_lens {
        files.push((
            ".holo/branches/public.lenses/build.toml".into(),
            "[hololens]\ncontainer = \"example/build:latest\"\n".into(),
        ));
    }
    if internal_lens {
        files.push((
            ".holo/lenses/build.toml".into(),
            "[hololens]\ncontainer = \"example/build:latest\"\n".into(),
        ));
    }

    sb.write_holo_workspace(&WorkspaceSpec {
        name: "lib".into(),
        branches: vec![(
            "public".into(),
            BranchSpec {
                lens: lens_flag,
                mappings: vec![("_lib".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        files,
        ..Default::default()
    })
}

/// Top-level workspace whose `site` branch maps `libsrc=>public`.
fn workspace_with_subprojection(sb: &Sandbox, sub_root: gix::ObjectId) -> gix::ObjectId {
    let sub_commit = sb.commit(sub_root, None, "lib snapshot");

    sb.write_holo_workspace(&WorkspaceSpec {
        name: "app".into(),
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![(
                    "_libsrc".into(),
                    MappingSpec {
                        holosource: Some("libsrc=>public".into()),
                        output: Some("vendor".into()),
                        ..Default::default()
                    },
                )],
                ..Default::default()
            },
        )],
        gitlinks: vec![("libsrc".into(), sub_commit)],
        files: vec![("app.js".into(), "app".into())],
        ..Default::default()
    })
}

#[test]
fn unlensed_subprojection_composes() {
    let sb = Sandbox::new();
    let sub_root = sub_workspace(&sb, None, false, false);
    let root = workspace_with_subprojection(&sb, sub_root);

    let result = holo_projector::project_branch(&sb.repo, root, "site").unwrap();
    let ctx = sb.ctx();
    assert!(has_path(&ctx, result, "vendor/lib.js"));
}

#[test]
fn lensed_subprojection_with_external_configs_is_refused() {
    let sb = Sandbox::new();
    let sub_root = sub_workspace(&sb, None, true, false);
    let root = workspace_with_subprojection(&sb, sub_root);

    let err = holo_projector::project_branch(&sb.repo, root, "site").unwrap_err();
    assert!(
        matches!(err, Error::LensedSubprojection { ref branch, .. } if branch == "public"),
        "expected LensedSubprojection, got: {err:?}"
    );
    assert_eq!(err.code(), "LENSED_SUBPROJECTION");
}

#[test]
fn lensed_subprojection_with_internal_configs_is_refused() {
    let sb = Sandbox::new();
    let sub_root = sub_workspace(&sb, None, false, true);
    let root = workspace_with_subprojection(&sb, sub_root);

    let err = holo_projector::project_branch(&sb.repo, root, "site").unwrap_err();
    assert_eq!(err.code(), "LENSED_SUBPROJECTION");
}

#[test]
fn subprojection_with_lens_false_composes_despite_configs() {
    let sb = Sandbox::new();
    // Lens configs exist, but the sub-branch explicitly opts out of lensing —
    // the oracle would skip the lens phase, so composition-only is faithful.
    let sub_root = sub_workspace(&sb, Some(false), true, true);
    let root = workspace_with_subprojection(&sb, sub_root);

    let result = holo_projector::project_branch(&sb.repo, root, "site").unwrap();
    let ctx = sb.ctx();
    assert!(has_path(&ctx, result, "vendor/lib.js"));
    // The un-lensed sub-output keeps its internal lens configs, like the oracle.
    assert!(has_path(&ctx, result, "vendor/.holo/lenses/build.toml"));
}

#[test]
fn error_codes_are_stable() {
    assert_eq!(
        Error::Config {
            path: "x".into(),
            message: "y".into()
        }
        .code(),
        "CONFIG"
    );
    assert_eq!(
        Error::SourceResolution {
            name: "x".into(),
            reason: "y".into()
        }
        .code(),
        "SOURCE_RESOLUTION"
    );
    assert_eq!(
        Error::CircularDependency { kind: "x".into() }.code(),
        "CIRCULAR_DEPENDENCY"
    );
    assert_eq!(Error::Other("x".into()).code(), "PROJECTION");
}
