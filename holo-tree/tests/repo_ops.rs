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
    assert!(
        matches!(err, holo_tree::Error::Git(_)),
        "CAS mismatch should surface as a git error, got {err:?}",
    );
    // Ref is unchanged.
    assert_eq!(resolve_ref(&sb.repo, "refs/heads/work").unwrap(), Some(b));
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
