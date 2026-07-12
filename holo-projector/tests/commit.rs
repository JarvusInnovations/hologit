//! Projection-commit parity with the JS oracle
//! (`specs/behaviors/projection-commits.md`).
//!
//! Every `ORACLE_*` constant below is a commit hash produced by the legacy
//! JS engine (`node bin/cli.js project proj --no-lens --commit-to=…`) under
//! pinned identity on a deterministic fixture repo. The capture procedure is
//! `tests/fixtures/capture-projection-commit-oracle.sh` — re-run it to
//! regenerate/verify the constants. These tests rebuild the identical
//! repository state through gix, drive `commit_projection` with the same
//! inputs, and require **byte-identical** commits (asserted on raw object
//! bytes first, so a mismatch shows *what* diverged, then on hashes).

mod helpers;

use gix::ObjectId;
use helpers::Sandbox;
use holo_projector::{commit_projection, CommitProjectionOptions, ProjectionSource};

// ── Oracle capture (see tests/fixtures/capture-projection-commit-oracle.sh) ─

const SOURCE_COMMIT: &str = "1b05a93bc326506d3640c9691b944f985879114c";
const PROJECTED_TREE: &str = "cd141f028d135c0dd3aa871fe9a05db2087f8ccc";
const DESCRIBE: &str = "1b05a93";
/// The absolute fixture path used by the capture script; the working-tree
/// mode commit embeds it in its message (oracle quirk, specced), so the
/// capture pins it.
const WORKING_PATH: &str = "/tmp/holo-oracle-fixture";

const ORACLE_INIT: &str = "8a3bd1d9f6d849cdae6bb41215cf07040f8c2946";
const ORACLE_FIRST: &str = "4ed3a7578aea4edc6f212c904eb00c9bfa84896d";
const ORACLE_SECOND: &str = "a7f4efd541fdddaed7c9952650deab68678165d5";
const ORACLE_CUSTOM: &str = "2d176173663d13ebbd5ec966189de992c5804183";
const ORACLE_NO_SOURCE: &str = "91a5b430b2de8cb13400e92a4f11296d7cc4d2b5";
const ORACLE_WORKING: &str = "22f6cef61d07b72bdd78acd1ea829e34813c9b90";

// ── Fixture reconstruction ──────────────────────────────────────────────────

fn oid(hex: &str) -> ObjectId {
    ObjectId::from_hex(hex.as_bytes()).expect("valid hex")
}

fn author() -> gix::actor::Signature {
    sig("Holo Author", "author@example.com", "1700000000 +0000")
}

fn committer() -> gix::actor::Signature {
    sig("Holo Committer", "committer@example.com", "1700000001 +0000")
}

fn sig(name: &str, email: &str, time: &str) -> gix::actor::Signature {
    gix::actor::SignatureRef {
        name: name.into(),
        email: email.into(),
        time,
    }
    .to_owned()
    .expect("valid signature")
}

/// Rebuild the capture script's fixture state: the same root tree and the
/// same source commit (asserted — everything downstream keys off them), then
/// project `proj` with the engine and assert the oracle's projected tree.
fn fixture(sandbox: &Sandbox) -> (ObjectId, ObjectId) {
    let root = sandbox.write_tree(&[
        ("README.md", "hello\n"),
        ("docs/index.md", "docs content\n"),
        (".holo/config.toml", "[holospace]\nname = \"fixture\"\n"),
        (
            ".holo/branches/proj/_fixture.toml",
            "[holomapping]\nfiles = \"**\"\n",
        ),
    ]);

    let source_commit = holo_projector::holo_tree::repo::commit_tree(
        &sandbox.repo,
        root,
        &[],
        "initial commit\n",
        Some(author()),
        Some(committer()),
    )
    .expect("source commit");
    assert_eq!(
        source_commit.to_string(),
        SOURCE_COMMIT,
        "fixture source commit must match the oracle capture"
    );

    let tree = holo_projector::project_branch(&sandbox.repo, root, "proj").expect("projection");
    assert_eq!(
        tree.to_string(),
        PROJECTED_TREE,
        "projected tree must match the oracle capture"
    );

    (tree, source_commit)
}

fn options<'a>(tree: ObjectId, source_commit: ObjectId) -> CommitProjectionOptions<'a> {
    CommitProjectionOptions {
        commit_ref: "refs/holo/projected",
        holobranch: "proj",
        tree,
        source_commit: Some(source_commit),
        source: ProjectionSource::Described {
            description: DESCRIBE,
        },
        message: None,
        author: Some(author()),
        committer: Some(committer()),
    }
}

fn raw_commit(sandbox: &Sandbox, id: ObjectId) -> String {
    let obj = sandbox.repo.find_object(id).expect("commit exists");
    String::from_utf8_lossy(&obj.data).into_owned()
}

fn ref_value(sandbox: &Sandbox, name: &str) -> Option<ObjectId> {
    sandbox
        .repo
        .try_find_reference(name)
        .expect("ref lookup")
        .map(|r| r.target().id().to_owned())
}

// ── Byte-for-byte parity ────────────────────────────────────────────────────

#[test]
fn first_projection_creates_init_commit_and_matches_oracle_bytes() {
    let sandbox = Sandbox::new();
    let (tree, source_commit) = fixture(&sandbox);

    let commit = commit_projection(&sandbox.repo, options(tree, source_commit)).expect("commit");

    // Byte comparison first: a mismatch shows exactly what diverged.
    let expected = format!(
        "tree {PROJECTED_TREE}\n\
         parent {ORACLE_INIT}\n\
         parent {SOURCE_COMMIT}\n\
         author Holo Author <author@example.com> 1700000000 +0000\n\
         committer Holo Committer <committer@example.com> 1700000001 +0000\n\
         \n\
         \u{2600} projected proj from {DESCRIBE}\n\
         \n\
         Source-holobranch: proj\n\
         Source-commit: {SOURCE_COMMIT}\n\
         Source: {DESCRIBE}\n"
    );
    assert_eq!(raw_commit(&sandbox, commit), expected);
    assert_eq!(commit.to_string(), ORACLE_FIRST);

    // The dangling init commit is byte-identical too.
    let expected_init = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
         author Holo Author <author@example.com> 1700000000 +0000\n\
         committer Holo Committer <committer@example.com> 1700000001 +0000\n\
         \n\
         \u{21a5} initialized proj\n";
    assert_eq!(raw_commit(&sandbox, oid(ORACLE_INIT)), expected_init);

    // The ref advanced to the projection commit — never to the init commit.
    assert_eq!(
        ref_value(&sandbox, "refs/holo/projected"),
        Some(oid(ORACLE_FIRST))
    );
}

#[test]
fn second_projection_uses_previous_commit_as_first_parent() {
    let sandbox = Sandbox::new();
    let (tree, source_commit) = fixture(&sandbox);

    let first = commit_projection(&sandbox.repo, options(tree, source_commit)).expect("first");
    let second = commit_projection(&sandbox.repo, options(tree, source_commit)).expect("second");

    assert_eq!(first.to_string(), ORACLE_FIRST);
    assert_eq!(second.to_string(), ORACLE_SECOND);
    assert!(raw_commit(&sandbox, second).contains(&format!("parent {ORACLE_FIRST}\n")));
    assert_eq!(
        ref_value(&sandbox, "refs/holo/projected"),
        Some(oid(ORACLE_SECOND))
    );
}

#[test]
fn message_override_replaces_subject_and_trailers() {
    let sandbox = Sandbox::new();
    let (tree, source_commit) = fixture(&sandbox);

    let commit = commit_projection(
        &sandbox.repo,
        CommitProjectionOptions {
            message: Some("custom message here"),
            ..options(tree, source_commit)
        },
    )
    .expect("commit");

    let raw = raw_commit(&sandbox, commit);
    assert!(raw.ends_with("\n\ncustom message here\n"), "raw was: {raw}");
    assert!(!raw.contains("Source-holobranch"), "trailers must be dropped");
    // Parents are unaffected by the override.
    assert!(raw.contains(&format!("parent {SOURCE_COMMIT}\n")));
    assert_eq!(commit.to_string(), ORACLE_CUSTOM);
}

#[test]
fn without_source_commit_single_parent_and_no_source_commit_trailer() {
    let sandbox = Sandbox::new();
    let (tree, _source_commit) = fixture(&sandbox);

    let commit = commit_projection(
        &sandbox.repo,
        CommitProjectionOptions {
            source_commit: None,
            ..options(tree, oid(SOURCE_COMMIT))
        },
    )
    .expect("commit");

    let raw = raw_commit(&sandbox, commit);
    assert!(!raw.contains("Source-commit:"));
    assert!(raw.contains(&format!("Source: {DESCRIBE}\n")));
    assert_eq!(raw.matches("\nparent ").count(), 1);
    assert_eq!(commit.to_string(), ORACLE_NO_SOURCE);
}

#[test]
fn working_tree_mode_embeds_path_and_drops_ref_mode_trailers() {
    let sandbox = Sandbox::new();
    let (tree, source_commit) = fixture(&sandbox);

    let commit = commit_projection(
        &sandbox.repo,
        CommitProjectionOptions {
            source: ProjectionSource::WorkTree { path: WORKING_PATH },
            ..options(tree, source_commit)
        },
    )
    .expect("commit");

    let raw = raw_commit(&sandbox, commit);
    assert!(raw.contains(&format!("\u{2600} projected proj from {WORKING_PATH}\n")));
    assert!(raw.contains("Source-holobranch: proj\n"));
    assert!(!raw.contains("Source-commit:"));
    assert!(!raw.contains("\nSource:"));
    // The source commit is still the second parent in working-tree mode.
    assert!(raw.contains(&format!("parent {SOURCE_COMMIT}\n")));
    assert_eq!(commit.to_string(), ORACLE_WORKING);
}

// ── Ref semantics ───────────────────────────────────────────────────────────

#[test]
fn bare_ref_name_normalizes_to_heads_and_matches_oracle() {
    let sandbox = Sandbox::new();
    let (tree, source_commit) = fixture(&sandbox);

    let commit = commit_projection(
        &sandbox.repo,
        CommitProjectionOptions {
            commit_ref: "projected-bare",
            ..options(tree, source_commit)
        },
    )
    .expect("commit");

    // Same inputs as case A -> same bytes, landed under refs/heads/.
    assert_eq!(commit.to_string(), ORACLE_FIRST);
    assert_eq!(
        ref_value(&sandbox, "refs/heads/projected-bare"),
        Some(oid(ORACLE_FIRST))
    );
}

#[test]
fn head_dereferences_to_its_branch() {
    let sandbox = Sandbox::new();
    let (tree, source_commit) = fixture(&sandbox);

    let commit = commit_projection(
        &sandbox.repo,
        CommitProjectionOptions {
            commit_ref: "HEAD",
            ..options(tree, source_commit)
        },
    )
    .expect("commit");

    // HEAD itself stays symbolic; the branch it points at advanced.
    let head = sandbox
        .repo
        .find_reference("HEAD")
        .expect("HEAD exists");
    let gix::refs::TargetRef::Symbolic(branch) = head.target() else {
        panic!("HEAD must remain symbolic");
    };
    let branch = branch.as_bstr().to_string();
    assert_eq!(ref_value(&sandbox, &branch), Some(commit));

    // Unborn HEAD -> init-commit first parent, same bytes as case A.
    assert_eq!(commit.to_string(), ORACLE_FIRST);
}
