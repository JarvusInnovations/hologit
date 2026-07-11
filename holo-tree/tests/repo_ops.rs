//! Tests for repo-level helpers used by the napi binding / gitsheets:
//! `resolve_ref` and the compare-and-swap variant of `update_ref`.

mod helpers;

use helpers::Sandbox;
use holo_tree::repo::{resolve_ref, update_ref};

/// Build two distinct commits (A then B, B child of A) on an empty tree.
fn two_commits(sb: &Sandbox) -> (gix::ObjectId, gix::ObjectId) {
    let tree_a = sb.write_tree(&[("a.toml", "id = 1\n")]);
    let a = sb.commit(tree_a, None, "a");
    let tree_b = sb.write_tree(&[("b.toml", "id = 2\n")]);
    let b = sb.commit(tree_b, Some(a), "b");
    (a, b)
}

#[test]
fn resolve_ref_returns_commit_hash_for_a_branch() {
    let sb = Sandbox::new();
    let (a, _) = two_commits(&sb);
    sb.set_ref("refs/heads/work", a);

    assert_eq!(resolve_ref(&sb.repo, "refs/heads/work").unwrap(), Some(a));
    // A bare object id resolves to itself.
    assert_eq!(resolve_ref(&sb.repo, &a.to_string()).unwrap(), Some(a));
}

#[test]
fn resolve_ref_returns_none_for_unknown_ref() {
    let sb = Sandbox::new();
    let (a, _) = two_commits(&sb);
    sb.set_ref("refs/heads/work", a);

    assert_eq!(resolve_ref(&sb.repo, "refs/heads/nope").unwrap(), None);
    assert_eq!(resolve_ref(&sb.repo, "does-not-exist").unwrap(), None);
}

#[test]
fn update_ref_cas_succeeds_when_expected_matches() {
    let sb = Sandbox::new();
    let (a, b) = two_commits(&sb);
    sb.set_ref("refs/heads/work", a);

    update_ref(&sb.repo, "refs/heads/work", b, Some(a)).unwrap();
    assert_eq!(resolve_ref(&sb.repo, "refs/heads/work").unwrap(), Some(b));
}

#[test]
fn update_ref_cas_fails_when_expected_does_not_match() {
    let sb = Sandbox::new();
    let (a, b) = two_commits(&sb);
    sb.set_ref("refs/heads/work", b); // ref is at B...

    // ...but we claim it should be at A — the swap must be rejected.
    let err = update_ref(&sb.repo, "refs/heads/work", a, Some(a)).unwrap_err();
    // Per specs/api/errors.md: assert the stable code, never message text.
    assert_eq!(
        err.code(),
        "REF_CONFLICT",
        "CAS mismatch must surface as REF_CONFLICT, got {err:?}",
    );
    // Ref is unchanged.
    assert_eq!(resolve_ref(&sb.repo, "refs/heads/work").unwrap(), Some(b));
}

#[test]
fn update_ref_cas_fails_when_ref_is_missing() {
    let sb = Sandbox::new();
    let (a, b) = two_commits(&sb);
    // No ref exists, but the caller claims it should be at A.
    let err = update_ref(&sb.repo, "refs/heads/ghost", b, Some(a)).unwrap_err();
    assert_eq!(
        err.code(),
        "REF_CONFLICT",
        "CAS against a missing ref must surface as REF_CONFLICT, got {err:?}",
    );
}

#[test]
fn update_ref_without_expected_forces() {
    let sb = Sandbox::new();
    let (a, b) = two_commits(&sb);
    sb.set_ref("refs/heads/work", a);

    // No expected_old → unconditional set, even though current != target's parent.
    update_ref(&sb.repo, "refs/heads/work", b, None).unwrap();
    assert_eq!(resolve_ref(&sb.repo, "refs/heads/work").unwrap(), Some(b));
}

/// The reflog identity must come from the committer of the commit the ref now
/// points at — not from ambient git config. The sandbox commits are stamped
/// "Test <test@test>", so that is what the reflog entry must record, regardless
/// of whatever `user.name` / `user.email` the machine running the test has.
#[test]
fn update_ref_reflog_identity_comes_from_commit_committer() {
    let sb = Sandbox::new();
    let (a, _) = two_commits(&sb);
    sb.enable_reflogs();
    let repo = sb.open_isolated();

    update_ref(&repo, "refs/heads/work", a, None).unwrap();

    let reference = repo.find_reference("refs/heads/work").unwrap();
    let mut platform = reference.log_iter();
    let iter = platform
        .all()
        .unwrap()
        .expect("update_ref should have written a reflog");

    let mut last = None;
    for line in iter {
        let line = line.unwrap();
        last = Some((
            line.signature.name.to_string(),
            line.signature.email.to_string(),
        ));
    }
    let (name, email) = last.expect("reflog should have at least one entry");
    assert_eq!(name, "Test", "reflog name should be the commit's committer");
    assert_eq!(
        email, "test@test",
        "reflog email should be the commit's committer"
    );
}

/// Regression for #476: a ref update on a fully-specified commit must not depend
/// on ambient git config. We reopen the sandbox repo with `isolated()` options —
/// which ignore environment and global/system git config, so no `user.name` /
/// `user.email` is visible — and confirm `update_ref` still succeeds. gix's
/// convenience `reference()` fails here with "The reflog could not be created or
/// updated"; deriving the reflog identity from the commit's committer fixes it.
#[test]
fn update_ref_succeeds_without_ambient_git_identity() {
    let sb = Sandbox::new();
    let (a, b) = two_commits(&sb);
    sb.set_ref("refs/heads/work", a);
    // Reproduce a CI checkout: reflogs on (so the reflog identity is actually
    // needed) but no ambient git identity available.
    sb.enable_reflogs();
    let isolated = sb.open_isolated();

    update_ref(&isolated, "refs/heads/work", b, Some(a)).unwrap();
    assert_eq!(resolve_ref(&isolated, "refs/heads/work").unwrap(), Some(b));
}
