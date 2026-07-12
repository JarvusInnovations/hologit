//! Lens execution integration tests (`specs/behaviors/lensing.md`).
//!
//! Container execution is exercised through a mock `ContainerRuntime` whose
//! `run_one_shot` implements the v2 one-shot job protocol in-process (an SDK
//! stand-in): it ingests the input bundle into a scratch job repo, applies a
//! deterministic transform, and returns a result bundle — so the full engine
//! path (wrapper commit, bundle exchange, parent verification, error
//! commits, cache refs) runs for real without a container engine.

mod helpers;

use std::time::Duration;

use gix::ObjectId;
use helpers::Sandbox;
use holo_projector::holo_tree::{Context, MutableTree, TreeCache};
use holo_projector::lens::{
    self, runtime::LocalImage, runtime::OneShotOutcome, ContainerRuntime, LensEngine,
    RegistryClient,
};

// ── Mock SDK runtime ───────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Behavior {
    /// Implement the protocol: output tree = input tree + `lens-output.txt`.
    Success,
    /// Emit a structured error bundle (exit 3, phase transform).
    StructuredError,
    /// Exit 0 with garbage on stdout.
    Garbage,
    /// Exit 1 with empty stdout.
    EmptyStdout,
    /// Report deadline expiry.
    Timeout,
    /// Panic if executed (used to prove cache hits skip execution).
    MustNotRun,
}

struct MockRuntime {
    behavior: Behavior,
    /// Result of local image inspection.
    image: Option<LocalImage>,
    /// The v2 protocol label value.
    label: Option<String>,
}

impl MockRuntime {
    fn local_only(behavior: Behavior) -> Self {
        MockRuntime {
            behavior,
            image: Some(LocalImage {
                id: format!("sha256:{}", "ab".repeat(32)),
                repo_digests: vec![],
            }),
            label: Some("2".to_string()),
        }
    }
}

struct NoRegistry;

impl RegistryClient for NoRegistry {
    fn manifest_digest(&self, reference: &str) -> holo_projector::error::Result<String> {
        panic!("registry must not be consulted for {reference}");
    }
}

impl ContainerRuntime for MockRuntime {
    fn inspect_local(
        &self,
        _reference: &str,
    ) -> holo_projector::error::Result<Option<LocalImage>> {
        Ok(self.image.clone())
    }

    fn pull(&self, reference: &str) -> holo_projector::error::Result<()> {
        panic!("pull must not be attempted for {reference}");
    }

    fn protocol_label(
        &self,
        _reference: &str,
    ) -> holo_projector::error::Result<Option<String>> {
        Ok(self.label.clone())
    }

    fn run_one_shot(
        &self,
        _image: &str,
        spec_hash: &str,
        input_bundle: &[u8],
        _deadline: Duration,
    ) -> holo_projector::error::Result<OneShotOutcome> {
        match self.behavior {
            Behavior::MustNotRun => panic!("lens executed despite a cached result"),
            Behavior::Timeout => Ok(OneShotOutcome {
                exit_code: None,
                stdout: vec![],
                stderr_tail: String::new(),
                timed_out: true,
            }),
            Behavior::EmptyStdout => Ok(OneShotOutcome {
                exit_code: Some(1),
                stdout: vec![],
                stderr_tail: "tool never started".into(),
                timed_out: false,
            }),
            Behavior::Garbage => Ok(OneShotOutcome {
                exit_code: Some(0),
                stdout: b"this is not a git bundle".to_vec(),
                stderr_tail: String::new(),
                timed_out: false,
            }),
            Behavior::Success => sdk_one_shot(spec_hash, input_bundle, false),
            Behavior::StructuredError => sdk_one_shot(spec_hash, input_bundle, true),
        }
    }
}

/// The in-process SDK: ingest the input bundle, transform (or fail), emit a
/// result bundle.
fn sdk_one_shot(
    spec_hash: &str,
    input_bundle: &[u8],
    fail: bool,
) -> holo_projector::error::Result<OneShotOutcome> {
    let scratch = tempfile::tempdir().expect("sdk scratch");
    let job_git = scratch.path().join("job.git");
    let run_git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&job_git)
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };

    let repo = gix::init_bare(&job_git).expect("init job repo");

    let bundle_path = scratch.path().join("input.bundle");
    std::fs::write(&bundle_path, input_bundle).unwrap();
    run_git(&[
        "fetch",
        bundle_path.to_str().unwrap(),
        "+refs/jobs/*:refs/jobs/*",
    ]);

    let input_ref = format!("refs/jobs/{spec_hash}/input");
    let input_commit = holo_projector::holo_tree::repo::resolve_ref(&repo, &input_ref)
        .unwrap()
        .expect("input ref delivered");

    let cache = TreeCache::new();
    let ctx = Context::new(&repo, &cache);

    let result_ref;
    if fail {
        // Structured error commit: parentless, tree carrying the contract
        // entries (exit-code is the inner tool's real status).
        let mut tree = MutableTree::empty();
        tree.write_child(&ctx, "exit-code", "3").unwrap();
        tree.write_child(&ctx, "phase", "transform").unwrap();
        tree.write_child(&ctx, "log", "boom: tool exploded\n").unwrap();
        tree.write_child(&ctx, "command", "mock-tool build").unwrap();
        let tree_id = tree.write(&ctx).unwrap();
        let commit = holo_projector::holo_tree::repo::commit_tree(
            &repo,
            tree_id,
            &[],
            &format!("lens job {spec_hash} error"),
            None,
            None,
        )
        .unwrap();
        result_ref = format!("refs/jobs/{spec_hash}/error");
        holo_projector::holo_tree::repo::update_ref(&repo, &result_ref, commit, None).unwrap();
    } else {
        // Transform: output tree = input/ subtree + lens-output.txt naming
        // the spec (proves the wrapper delivered `.holospec/lens.toml`).
        let commit_obj = repo.find_object(input_commit).unwrap();
        let commit = commit_obj.try_into_commit().unwrap();
        let wrapper_tree = commit.tree_id().unwrap().detach();

        let mut wrapper = MutableTree::new(wrapper_tree);
        let spec_toml = wrapper
            .read_blob(&ctx, ".holospec/lens.toml")
            .unwrap()
            .expect("wrapper carries the spec file");
        let spec_text = String::from_utf8(spec_toml).unwrap();
        assert!(spec_text.starts_with("[holospec.lens]\n"));

        let input_subtree = wrapper
            .get_subtree(&ctx, "input")
            .unwrap()
            .expect("wrapper carries input/")
            .write(&ctx)
            .unwrap();

        let mut output = MutableTree::new(input_subtree);
        output
            .write_child(&ctx, "lens-output.txt", &format!("lensed {spec_hash}\n"))
            .unwrap();
        let output_tree = output.write(&ctx).unwrap();
        let commit = holo_projector::holo_tree::repo::commit_tree(
            &repo,
            output_tree,
            &[input_commit],
            &format!("lens job {spec_hash} output"),
            None,
            None,
        )
        .unwrap();
        result_ref = format!("refs/jobs/{spec_hash}/output");
        holo_projector::holo_tree::repo::update_ref(&repo, &result_ref, commit, None).unwrap();
    }

    let result_bundle = scratch.path().join("result.bundle");
    run_git(&["bundle", "create", result_bundle.to_str().unwrap(), &result_ref]);
    let stdout = std::fs::read(&result_bundle).unwrap();

    Ok(OneShotOutcome {
        exit_code: Some(if fail { 3 } else { 0 }),
        stdout,
        stderr_tail: String::new(),
        timed_out: false,
    })
}

// ── Workspace fixtures ─────────────────────────────────────────────────────

/// Workspace with an external lens on branch `site`:
/// mapping `_main` (self-source, root `docs`) + `.holo/branches/site.lenses/mark.toml`.
fn external_lens_workspace(sandbox: &Sandbox) -> ObjectId {
    sandbox.write_tree(&[
        (".holo/config.toml", "[holospace]\nname = \"main\"\n"),
        (
            ".holo/branches/site/_main.toml",
            "[holomapping]\nfiles = \"**\"\nroot = \"docs\"\n",
        ),
        (
            ".holo/branches/site.lenses/mark.toml",
            "[hololens]\ncontainer = \"test-lens:dev\"\n",
        ),
        ("docs/readme.md", "hello\n"),
    ])
}

fn tree_child_names(sandbox: &Sandbox, tree_id: ObjectId) -> Vec<String> {
    let ctx = sandbox.ctx();
    let mut tree = MutableTree::new(tree_id);
    tree.ensure_children(&ctx).unwrap();
    tree.children.iter().flatten().map(|(n, _)| n.clone()).collect()
}

fn read_blob_text(sandbox: &Sandbox, tree_id: ObjectId, path: &str) -> Option<String> {
    let ctx = sandbox.ctx();
    let mut tree = MutableTree::new(tree_id);
    tree.read_blob(&ctx, path)
        .unwrap()
        .map(|data| String::from_utf8(data).unwrap())
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[test]
fn one_shot_external_lens_end_to_end() {
    let sandbox = Sandbox::new();
    let ws = external_lens_workspace(&sandbox);

    let runtime = MockRuntime::local_only(Behavior::Success);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);

    let output = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap();

    let names = tree_child_names(&sandbox, output);
    assert_eq!(names, ["lens-output.txt", "readme.md"]);
    assert_eq!(
        read_blob_text(&sandbox, output, "readme.md").as_deref(),
        Some("hello\n")
    );

    // The spec-keyed cache ref was written and peels to the lensed tree —
    // and a second projection is satisfied from it without touching the
    // runtime.
    let poisoned = MockRuntime::local_only(Behavior::MustNotRun);
    let engine = LensEngine::new(&poisoned, &registry);
    let cached = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap();
    assert_eq!(cached, output);

    // refresh forces re-execution
    let refreshed = MockRuntime::local_only(Behavior::Success);
    let mut engine = LensEngine::new(&refreshed, &registry);
    engine.refresh = true;
    let rerun = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap();
    assert_eq!(rerun, output);

    // The transient per-job input ref was cleaned up.
    let refs: Vec<String> = sandbox
        .repo
        .references()
        .unwrap()
        .all()
        .unwrap()
        .filter_map(|r| r.ok())
        .map(|r| r.name().as_bstr().to_string())
        .collect();
    assert!(
        !refs.iter().any(|r| r.starts_with("refs/jobs/") && r.ends_with("/input")),
        "transient input ref left behind: {refs:?}"
    );
    // The spec object is anchored for fetching/GC.
    assert!(refs.iter().any(|r| r.starts_with("refs/holo/spec/")));
}

#[test]
fn lens_flag_false_skips_lens_phase() {
    let sandbox = Sandbox::new();
    let ws = external_lens_workspace(&sandbox);

    let runtime = MockRuntime::local_only(Behavior::MustNotRun);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);

    // explicit override false: composition-only output
    let output =
        lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, Some(false)).unwrap();
    assert_eq!(tree_child_names(&sandbox, output), ["readme.md"]);
}

#[test]
fn structured_lens_failure() {
    let sandbox = Sandbox::new();
    let ws = external_lens_workspace(&sandbox);

    let runtime = MockRuntime::local_only(Behavior::StructuredError);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);

    let err = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap_err();
    assert_eq!(err.code(), "LENS_FAILED");
    match err {
        holo_projector::error::Error::LensFailed {
            exit_code,
            phase,
            log,
            command,
            ..
        } => {
            assert_eq!(exit_code, 3);
            assert_eq!(phase.as_deref(), Some("transform"));
            assert_eq!(log.as_deref(), Some("boom: tool exploded\n"));
            assert_eq!(command.as_deref(), Some("mock-tool build"));
        }
        other => panic!("unexpected error: {other:?}"),
    }

    // A failure writes no cache ref: a retry executes again.
    let refs: Vec<String> = sandbox
        .repo
        .references()
        .unwrap()
        .all()
        .unwrap()
        .filter_map(|r| r.ok())
        .map(|r| r.name().as_bstr().to_string())
        .collect();
    assert!(!refs.iter().any(|r| r.starts_with("refs/holo/lens/")));
}

#[test]
fn transport_errors_are_distinct() {
    let sandbox = Sandbox::new();
    let ws = external_lens_workspace(&sandbox);
    let registry = NoRegistry;

    let garbage = MockRuntime::local_only(Behavior::Garbage);
    let engine = LensEngine::new(&garbage, &registry);
    let err = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap_err();
    assert_eq!(err.code(), "LENS_TRANSPORT");

    let empty = MockRuntime::local_only(Behavior::EmptyStdout);
    let engine = LensEngine::new(&empty, &registry);
    let err = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap_err();
    assert_eq!(err.code(), "LENS_TRANSPORT");
}

#[test]
fn deadline_expiry_is_lens_timeout() {
    let sandbox = Sandbox::new();
    let ws = external_lens_workspace(&sandbox);

    let runtime = MockRuntime::local_only(Behavior::Timeout);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);

    let err = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap_err();
    assert_eq!(err.code(), "LENS_TIMEOUT");
}

#[test]
fn v1_only_image_is_refused_with_lens_protocol() {
    let sandbox = Sandbox::new();
    let ws = external_lens_workspace(&sandbox);

    let mut runtime = MockRuntime::local_only(Behavior::MustNotRun);
    runtime.label = None; // no sh.holo.lens.protocol label → v1 image
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);

    let err = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap_err();
    assert_eq!(err.code(), "LENS_PROTOCOL");
}

#[test]
fn internal_lens_applies_and_is_stripped() {
    let sandbox = Sandbox::new();
    // The lens config rides inside the mapped tree, so it surfaces in the
    // composited output at .holo/lenses/ (internal discovery).
    let ws = sandbox.write_tree(&[
        (".holo/config.toml", "[holospace]\nname = \"main\"\n"),
        (
            ".holo/branches/site/_main.toml",
            "[holomapping]\nfiles = \"**\"\n",
        ),
        (
            ".holo/lenses/mark.toml",
            "[hololens]\ncontainer = \"test-lens:dev\"\n",
        ),
        ("docs/readme.md", "hello\n"),
    ]);

    let runtime = MockRuntime::local_only(Behavior::Success);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);

    let output = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap();

    // .holo/lenses stripped, then bare .holo stripped (only config.toml
    // left) — the lens transform output (which included the input's .holo)
    // wins on merge, so .holo/lenses is re-introduced by overlay and must
    // still be stripped afterwards.
    let names = tree_child_names(&sandbox, output);
    assert_eq!(names, ["docs", "lens-output.txt"]);
}

#[test]
fn lensed_subprojection_runs_natively_where_pure_engine_refuses() {
    let sandbox = Sandbox::new();
    let ws = sandbox.write_tree(&[
        (".holo/config.toml", "[holospace]\nname = \"main\"\n"),
        (
            ".holo/branches/site/_sub.toml",
            "[holomapping]\nholosource = \"main=>subsite\"\nfiles = \"**\"\n",
        ),
        (
            ".holo/branches/subsite/_main.toml",
            "[holomapping]\nfiles = \"**\"\nroot = \"docs\"\n",
        ),
        (
            ".holo/branches/subsite.lenses/mark.toml",
            "[hololens]\ncontainer = \"test-lens:dev\"\n",
        ),
        ("docs/readme.md", "hello\n"),
    ]);

    // The composition-only engine must refuse (silently skipping the lens
    // phase would produce a wrong hash).
    let err = holo_projector::project_branch(&sandbox.repo, ws, "site").unwrap_err();
    assert_eq!(err.code(), "LENSED_SUBPROJECTION");

    // The lensing engine lenses the sub-projection natively.
    let runtime = MockRuntime::local_only(Behavior::Success);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);
    let output = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap();

    let names = tree_child_names(&sandbox, output);
    assert_eq!(names, ["lens-output.txt", "readme.md"]);
}

#[test]
fn subprojection_lens_flag_false_disables_lensing() {
    let sandbox = Sandbox::new();
    let ws = sandbox.write_tree(&[
        (".holo/config.toml", "[holospace]\nname = \"main\"\n"),
        (
            ".holo/branches/site/_sub.toml",
            "[holomapping]\nholosource = \"main=>subsite\"\nfiles = \"**\"\n",
        ),
        (
            ".holo/branches/subsite.toml",
            "[holobranch]\nlens = false\n",
        ),
        (
            ".holo/branches/subsite/_main.toml",
            "[holomapping]\nfiles = \"**\"\nroot = \"docs\"\n",
        ),
        (
            ".holo/branches/subsite.lenses/mark.toml",
            "[hololens]\ncontainer = \"test-lens:dev\"\n",
        ),
        ("docs/readme.md", "hello\n"),
    ]);

    // lens = false on the sub-branch: both engines compose without lensing
    // and agree.
    let pure = holo_projector::project_branch(&sandbox.repo, ws, "site").unwrap();

    let runtime = MockRuntime::local_only(Behavior::MustNotRun);
    let registry = NoRegistry;
    let engine = LensEngine::new(&runtime, &registry);
    let lensed = lens::project_branch_lensed(&sandbox.repo, ws, "site", &engine, None).unwrap();

    assert_eq!(pure, lensed);
    assert_eq!(tree_child_names(&sandbox, pure), ["readme.md"]);
}

// ── Cross-engine spec known-answer tests ───────────────────────────────────
//
// Expected bytes/hashes generated with the JS engine's exact pipeline
// (`deepSortKeys` + `@iarna/toml@2.2.x` stringify + git blob hash), i.e.
// what `lib/SpecObject.js` writes. Spec-hash identity is what makes
// JS-written `refs/holo/lens/…` cache refs satisfy Rust cache checks and
// vice versa.

#[test]
fn spec_known_answer_registry_resolved() {
    let sandbox = Sandbox::new();

    let table: toml::Table = r#"
[hololens]
container = "ghcr.io/hologit/lenses/mkdocs:latest"

[hololens.mkdocs]
requirements = [
    "mkdocs-material",
    "mkdocs-awesome-pages-plugin",
    "mdx_truly_sane_lists"
]

[hololens.output]
merge = "replace"
"#
    .parse()
    .unwrap();
    let hololens = match table.get("hololens") {
        Some(toml::Value::Table(t)) => t.clone(),
        _ => unreachable!(),
    };

    let config = lens::LensConfig::normalize("mkdocs", hololens, None).unwrap();
    let input_tree =
        ObjectId::from_hex(b"aaaabbbbccccddddeeeeffff0000111122223333").unwrap();
    let spec_table = lens::spec::build_spec_table(
        &config,
        "ghcr.io/hologit/lenses/mkdocs@sha256:6b6b0bdb5beb2b3f852cc1cdfb7d2a67fc036bce7f26ac63efc39e8e2a2a4738",
        false,
        input_tree,
    );
    let spec = lens::spec::write_spec(&sandbox.repo, spec_table).unwrap();

    assert_eq!(
        spec.toml,
        "[holospec.lens]\ncontainer = \"ghcr.io/hologit/lenses/mkdocs@sha256:6b6b0bdb5beb2b3f852cc1cdfb7d2a67fc036bce7f26ac63efc39e8e2a2a4738\"\ninput = \"aaaabbbbccccddddeeeeffff0000111122223333\"\n\n  [holospec.lens.mkdocs]\n  requirements = [\n  \"mkdocs-material\",\n  \"mkdocs-awesome-pages-plugin\",\n  \"mdx_truly_sane_lists\"\n]\n"
    );
    assert_eq!(
        spec.hash.to_string(),
        "2fcd4f440ce38035d9bd85aafd009cbf8cb5e8c6"
    );
    assert_eq!(
        spec.cache_ref,
        "refs/holo/lens/2f/cd4f440ce38035d9bd85aafd009cbf8cb5e8c6"
    );
}

#[test]
fn spec_known_answer_local_resolved() {
    let sandbox = Sandbox::new();

    let table: toml::Table = r#"
[hololens]
container = "my-local-lens:dev"
command = "build --out {{ output }}"
"#
    .parse()
    .unwrap();
    let hololens = match table.get("hololens") {
        Some(toml::Value::Table(t)) => t.clone(),
        _ => unreachable!(),
    };

    let data_tree =
        ObjectId::from_hex(b"fedcba9876543210fedcba9876543210fedcba98").unwrap();
    let config = lens::LensConfig::normalize("local", hololens, Some(data_tree)).unwrap();
    let input_tree =
        ObjectId::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
    let spec_table = lens::spec::build_spec_table(
        &config,
        "sha256:0f8acb0117e7fbdab9ecb551eee1d1c33741ad07d3d6ed268361291bc22d146d",
        true,
        input_tree,
    );
    let spec = lens::spec::write_spec(&sandbox.repo, spec_table).unwrap();

    assert_eq!(
        spec.toml,
        "[holospec.lens]\n_resolved = \"local\"\ncommand = \"build --out {{ output }}\"\ncontainer = \"sha256:0f8acb0117e7fbdab9ecb551eee1d1c33741ad07d3d6ed268361291bc22d146d\"\ndata = \"fedcba9876543210fedcba9876543210fedcba98\"\ninput = \"0123456789abcdef0123456789abcdef01234567\"\n"
    );
    assert_eq!(
        spec.hash.to_string(),
        "bd5289052f30b267f14e9621c8e1d8062dc07f8e"
    );
}
