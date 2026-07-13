//! Projection-commit creation: wrap a composed output tree in a git commit
//! and advance a target ref.
//!
//! This is an explicit **edge capability** layered on pure composition —
//! `project_branch` never writes refs or commits; hosts that want a
//! projection committed call [`commit_projection`] with the composed tree.
//! The commit's bytes are a pure function of the declared inputs, matching
//! the legacy JS engine byte-for-byte (`specs/behaviors/projection-commits.md`).

use std::borrow::Cow;

use gix::ObjectId;

use crate::error::{Error, Result};

/// Maximum symbolic-ref links to follow when resolving the target ref
/// (mirrors git's own symref depth limit).
const MAX_SYMREF_DEPTH: usize = 10;

/// Where a projection was taken from — decides the message's `from` clause
/// and whether the ref-mode trailers (`Source-commit`, `Source`) are emitted.
#[derive(Debug, Clone, Copy)]
pub enum ProjectionSource<'a> {
    /// Projected from a committed ref. `description` is the host-computed
    /// provenance string — the oracle CLI uses `git describe --always --tags
    /// <ref>` — and is treated as opaque: the engine never derives it, per
    /// the spec's "provenance strings are inputs, not derivations".
    Described { description: &'a str },
    /// Projected from a working tree at `path`. The path appears in the
    /// message's `from` clause; the ref-mode trailers are omitted (only
    /// `Source-holobranch` is emitted).
    WorkTree { path: &'a str },
}

/// Options for [`commit_projection`].
#[derive(Debug, Clone)]
pub struct CommitProjectionOptions<'a> {
    /// Target ref to advance (the oracle's `commitTo`). Normalized per the
    /// spec: `HEAD` passes through (and is dereferenced through symbolic
    /// refs, so the branch HEAD points at is what advances), names starting
    /// with `refs/` pass through, anything else becomes `refs/heads/<name>`.
    pub commit_ref: &'a str,
    /// The projected holobranch's name (message subject and
    /// `Source-holobranch` trailer).
    pub holobranch: &'a str,
    /// The composed output tree to commit.
    pub tree: ObjectId,
    /// The source commit the projection was taken from; becomes the second
    /// parent when present (in both ref and working-tree modes) and the
    /// `Source-commit` trailer (ref mode only).
    pub source_commit: Option<ObjectId>,
    /// Provenance of the projection (ref mode vs. working-tree mode).
    pub source: ProjectionSource<'a>,
    /// Message override. Replaces the **entire** default message — subject
    /// and all trailers (oracle quirk, ported). Parents are unaffected.
    pub message: Option<&'a str>,
    /// Explicit author; falls back to the repository's configured identity
    /// (git config / `GIT_AUTHOR_*` env), then holo-tree's default. Pass an
    /// explicit signature to reproduce a commit bit-for-bit.
    pub author: Option<gix::actor::Signature>,
    /// Explicit committer; same fallback chain as `author`.
    pub committer: Option<gix::actor::Signature>,
}

/// Create a projection commit for a composed output tree and advance the
/// target ref to it (`specs/behaviors/projection-commits.md`).
///
/// - **First parent**: the target ref's current value. When the ref does not
///   resolve, a dangling **init commit** (empty tree, no parents,
///   `↥ initialized <holobranch>`) is created and used instead; the ref
///   itself advances directly to the projection commit.
/// - **Second parent**: `source_commit`, when supplied.
/// - **Ref advance**: compare-and-swap on the ancestor observed above; a
///   concurrent writer surfaces as a structured `REF_CONFLICT` error rather
///   than being clobbered. When the ref did not exist at resolution time the
///   create is unconditional.
///
/// Returns the new projection commit's id.
pub fn commit_projection(
    repo: &gix::Repository,
    options: CommitProjectionOptions<'_>,
) -> Result<ObjectId> {
    let normalized = normalize_commit_ref(options.commit_ref);
    let (target_ref, ancestor) = resolve_target(repo, &normalized)?;
    commit_and_advance(repo, &target_ref, ancestor, options)
}

/// Create the commit against an already-resolved target ref + ancestor.
///
/// Split from [`commit_projection`] so the CAS failure path (ancestor moved
/// between resolution and advance) is directly testable.
fn commit_and_advance(
    repo: &gix::Repository,
    target_ref: &str,
    ancestor: Option<ObjectId>,
    options: CommitProjectionOptions<'_>,
) -> Result<ObjectId> {
    let CommitProjectionOptions {
        holobranch,
        tree,
        source_commit,
        source,
        message,
        author,
        committer,
        ..
    } = options;

    let first_parent = match ancestor {
        Some(id) => id,
        None => init_commit(repo, holobranch, author.clone(), committer.clone())?,
    };

    let mut parents = vec![first_parent];
    if let Some(src) = source_commit {
        parents.push(src);
    }

    let message = match message {
        Some(m) => ensure_trailing_newline(m),
        None => default_message(holobranch, source, source_commit),
    };

    let commit =
        holo_tree::repo::commit_tree(repo, tree, &parents, &message, author, committer)?;

    // CAS on the observed ancestor; unconditional create when absent.
    holo_tree::repo::update_ref(repo, target_ref, commit, ancestor)?;

    Ok(commit)
}

/// Create the init commit used as first parent when the target ref does not
/// exist yet: the empty tree, no parents, `↥ initialized <holobranch>`.
fn init_commit(
    repo: &gix::Repository,
    holobranch: &str,
    author: Option<gix::actor::Signature>,
    committer: Option<gix::actor::Signature>,
) -> Result<ObjectId> {
    // Materialize the empty tree so the commit never references a missing
    // object (git treats it as virtually present; not every consumer does).
    let empty_tree = repo
        .write_object(gix::objs::Tree::empty())
        .map_err(|e| Error::Tree(holo_tree::Error::Git(e.to_string())))?
        .detach();

    let message = format!("↥ initialized {holobranch}\n");
    Ok(holo_tree::repo::commit_tree(
        repo, empty_tree, &[], &message, author, committer,
    )?)
}

/// Normalize the oracle's `commitTo` value into a full ref name:
/// `HEAD` and `refs/...` pass through; anything else — including names
/// containing `/` — becomes `refs/heads/<name>`.
fn normalize_commit_ref(commit_ref: &str) -> Cow<'_, str> {
    if commit_ref == "HEAD" || commit_ref.starts_with("refs/") {
        Cow::Borrowed(commit_ref)
    } else {
        Cow::Owned(format!("refs/heads/{commit_ref}"))
    }
}

/// Resolve the normalized target ref to the concrete ref that will be
/// advanced and its current value: symbolic refs (e.g. `HEAD`) are followed
/// to their terminal ref name — matching `git update-ref HEAD` semantics —
/// and a missing or unborn ref yields `None` for the ancestor.
fn resolve_target(repo: &gix::Repository, refname: &str) -> Result<(String, Option<ObjectId>)> {
    let mut name = refname.to_string();

    for _ in 0..MAX_SYMREF_DEPTH {
        let reference = repo
            .try_find_reference(name.as_str())
            .map_err(|e| Error::Tree(holo_tree::Error::Git(e.to_string())))?;

        let Some(reference) = reference else {
            // Missing ref (or the unborn branch a symbolic ref pointed at):
            // this is the name to create, with no ancestor.
            return Ok((name, None));
        };

        match reference.target() {
            gix::refs::TargetRef::Object(id) => return Ok((name, Some(id.to_owned()))),
            gix::refs::TargetRef::Symbolic(symbolic) => {
                name = symbolic.as_bstr().to_string();
            }
        }
    }

    Err(Error::Other(format!(
        "symbolic ref chain too deep resolving '{refname}'"
    )))
}

/// Compose the default projection-commit message: subject, blank line, then
/// the trailer block in fixed order. Ends with exactly one newline (the
/// oracle inherits the same from `git commit-tree -m`).
fn default_message(
    holobranch: &str,
    source: ProjectionSource<'_>,
    source_commit: Option<ObjectId>,
) -> String {
    let from = match source {
        ProjectionSource::Described { description } => description,
        ProjectionSource::WorkTree { path } => path,
    };

    let mut message =
        format!("☀ projected {holobranch} from {from}\n\nSource-holobranch: {holobranch}\n");

    if let ProjectionSource::Described { description } = source {
        if let Some(src) = source_commit {
            message.push_str(&format!("Source-commit: {src}\n"));
        }
        message.push_str(&format!("Source: {description}\n"));
    }

    message
}

/// Append a trailing newline only when the message lacks one — the exact
/// behavior of `git commit-tree -m`, which the oracle's messages pass
/// through (a message already ending in `\n`, even several, is verbatim).
fn ensure_trailing_newline(message: &str) -> String {
    if message.ends_with('\n') {
        message.to_string()
    } else {
        format!("{message}\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(name: &str, email: &str, time: &str) -> gix::actor::Signature {
        gix::actor::SignatureRef {
            name: name.into(),
            email: email.into(),
            time,
        }
        .to_owned()
        .expect("valid signature")
    }

    fn test_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = gix::init_bare(dir.path()).expect("init bare repo");
        (dir, repo)
    }

    fn write_commit(repo: &gix::Repository, msg: &str) -> ObjectId {
        let tree = repo
            .write_object(gix::objs::Tree::empty())
            .unwrap()
            .detach();
        holo_tree::repo::commit_tree(
            repo,
            tree,
            &[],
            msg,
            Some(sig("Test", "test@test", "1700000000 +0000")),
            Some(sig("Test", "test@test", "1700000000 +0000")),
        )
        .unwrap()
    }

    #[test]
    fn normalize_commit_ref_matches_oracle_rule() {
        assert_eq!(normalize_commit_ref("HEAD"), "HEAD");
        assert_eq!(normalize_commit_ref("refs/holo/x"), "refs/holo/x");
        assert_eq!(normalize_commit_ref("refs/heads/main"), "refs/heads/main");
        assert_eq!(normalize_commit_ref("projected"), "refs/heads/projected");
        // Names containing '/' still get the refs/heads/ prefix (oracle rule;
        // differs from bare-name qualification elsewhere).
        assert_eq!(
            normalize_commit_ref("holo/projected"),
            "refs/heads/holo/projected"
        );
    }

    #[test]
    fn ensure_trailing_newline_matches_commit_tree() {
        assert_eq!(ensure_trailing_newline("plain"), "plain\n");
        assert_eq!(ensure_trailing_newline("kept\n"), "kept\n");
        assert_eq!(ensure_trailing_newline("multi\n\n"), "multi\n\n");
    }

    #[test]
    fn stale_ancestor_surfaces_ref_conflict() {
        let (_dir, repo) = test_repo();

        let stale = write_commit(&repo, "stale\n");
        let current = write_commit(&repo, "current\n");
        holo_tree::repo::update_ref(&repo, "refs/heads/target", current, None).unwrap();

        // The ref moved to `current` after we (hypothetically) observed `stale`.
        let err = commit_and_advance(
            &repo,
            "refs/heads/target",
            Some(stale),
            CommitProjectionOptions {
                commit_ref: "refs/heads/target",
                holobranch: "proj",
                tree: repo
                    .write_object(gix::objs::Tree::empty())
                    .unwrap()
                    .detach(),
                source_commit: None,
                source: ProjectionSource::Described { description: "d" },
                message: None,
                author: Some(sig("Test", "test@test", "1700000000 +0000")),
                committer: Some(sig("Test", "test@test", "1700000000 +0000")),
            },
        )
        .unwrap_err();

        assert_eq!(err.code(), "REF_CONFLICT");

        // The concurrent writer's value survived.
        let (_, value) = resolve_target(&repo, "refs/heads/target").unwrap();
        assert_eq!(value, Some(current));
    }

    #[test]
    fn missing_ref_resolves_to_no_ancestor() {
        let (_dir, repo) = test_repo();
        let (name, value) = resolve_target(&repo, "refs/holo/projected").unwrap();
        assert_eq!(name, "refs/holo/projected");
        assert_eq!(value, None);
    }

    #[test]
    fn unborn_head_resolves_to_its_branch() {
        let (_dir, repo) = test_repo();
        let (name, value) = resolve_target(&repo, "HEAD").unwrap();
        assert!(
            name.starts_with("refs/heads/"),
            "HEAD should dereference to its branch, got {name}"
        );
        assert_eq!(value, None);
    }
}
