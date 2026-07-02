//! Git repository helpers: ref resolution, commit creation, ref updates.

use gix::ObjectId;

use crate::error::{Error, Result};
use crate::tree::MutableTree;

/// Create a MutableTree from a git ref (branch, tag, commit hash).
/// Resolves ref → commit → tree, peeling tags if needed.
pub fn create_tree_from_ref(repo: &gix::Repository, git_ref: &str) -> Result<MutableTree> {
    let spec = repo.rev_parse_single(git_ref)?;
    let mut obj = spec.object().map_err(|e| Error::Git(e.to_string()))?;

    // Peel tags
    while obj.kind == gix::object::Kind::Tag {
        let tag = obj
            .try_into_tag()
            .map_err(|_| Error::Git("failed to parse tag".into()))?;
        let target = tag
            .target_id()
            .map_err(|e| Error::Git(e.to_string()))?
            .detach();
        obj = repo.find_object(target)?;
    }

    let commit = obj
        .try_into_commit()
        .map_err(|_| Error::Git(format!("{git_ref} does not resolve to a commit")))?;
    let tree_id = commit
        .tree_id()
        .map_err(|e| Error::Git(e.to_string()))?
        .detach();

    Ok(MutableTree::new(tree_id))
}

/// Create a MutableTree by navigating into a tree object at a subpath.
///
/// Given a tree OID and a slash-separated path, walks each component
/// to find the final subtree. Returns an error if any component is missing.
pub fn create_tree_from_path(
    repo: &gix::Repository,
    tree_id: ObjectId,
    path: &str,
) -> Result<MutableTree> {
    use gix::bstr::ByteSlice;

    if path == "." || path.is_empty() {
        return Ok(MutableTree::new(tree_id));
    }

    let mut current = tree_id;
    for component in path.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }

        let obj = repo.find_object(current)?;
        let tree = obj
            .try_into_tree()
            .map_err(|_| Error::NotATree(current.to_string()))?;

        let entry = tree
            .iter()
            .filter_map(|e| e.ok())
            .find(|e| {
                e.filename()
                    .to_str()
                    .map(|s| s == component)
                    .unwrap_or(false)
            })
            .ok_or_else(|| Error::PathNotFound {
                component: component.to_string(),
            })?;

        current = entry.oid().to_owned();
    }

    Ok(MutableTree::new(current))
}

/// Create a git commit pointing to a tree.
///
/// Identity resolution, per field, is: explicit `author`/`committer` argument →
/// the repository's configured identity (git config or `GIT_AUTHOR_*`/
/// `GIT_COMMITTER_*` env) → a "holo-tree" fallback. Passing explicit signatures
/// (with timestamps) is what lets an embedding consumer reproduce a specific
/// commit bit-for-bit — e.g. match `git commit-tree` under pinned dates.
pub fn commit_tree(
    repo: &gix::Repository,
    tree_hash: ObjectId,
    parents: &[ObjectId],
    message: &str,
    author: Option<gix::actor::Signature>,
    committer: Option<gix::actor::Signature>,
) -> Result<ObjectId> {
    use gix::objs::Commit;

    let author = author
        .or_else(|| {
            repo.author()
                .and_then(|r| r.ok())
                .map(|s| s.to_owned())
                .transpose()
                .ok()
                .flatten()
        })
        .unwrap_or_else(default_signature);

    let committer = committer
        .or_else(|| {
            repo.committer()
                .and_then(|r| r.ok())
                .map(|s| s.to_owned())
                .transpose()
                .ok()
                .flatten()
        })
        .unwrap_or_else(default_signature);

    let commit = Commit {
        tree: tree_hash,
        parents: parents.into(),
        author,
        committer,
        encoding: None,
        message: message.into(),
        extra_headers: vec![],
    };

    let id = repo
        .write_object(&commit)
        .map_err(|e| Error::Git(e.to_string()))?;
    Ok(id.detach())
}

/// Resolve a ref / rev-spec (branch, tag, `HEAD`, hash, …) to its object hash,
/// peeling annotated tags down to the object they point at (typically a commit).
///
/// Returns `Ok(None)` when the ref does not resolve — an unknown name, an
/// unborn branch, or any spec gix can't parse to a single object. That is the
/// natural "does this ref exist?" contract a caller wants from a resolver
/// (gitsheets uses it to discover the current commit before a compare-and-swap
/// `update_ref`). Genuine ODB failures *after* a spec resolves still surface as
/// `Err`.
pub fn resolve_ref(repo: &gix::Repository, git_ref: &str) -> Result<Option<ObjectId>> {
    let spec = match repo.rev_parse_single(git_ref) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let mut obj = spec.object().map_err(|e| Error::Git(e.to_string()))?;

    // Peel annotated tags to their target object.
    while obj.kind == gix::object::Kind::Tag {
        let tag = obj
            .try_into_tag()
            .map_err(|_| Error::Git("failed to parse tag".into()))?;
        let target = tag
            .target_id()
            .map_err(|e| Error::Git(e.to_string()))?
            .detach();
        obj = repo.find_object(target)?;
    }

    Ok(Some(obj.id))
}

/// Update a git ref to point at a new object.
///
/// Accepts the same leniency as `git update-ref`: a bare branch name (e.g.
/// `main`) is qualified to `refs/heads/main`. Already-qualified names (anything
/// containing `/`, like `refs/heads/x` or `refs/tags/x`) and all-caps pseudo-refs
/// (e.g. `HEAD`) pass through unchanged. Without this, gix's `reference()`
/// rejects a standalone lowercase name ("Standalone references must be all
/// uppercased").
///
/// When `expected_old` is `Some`, this is a **compare-and-swap**: the update
/// only succeeds if the ref currently resolves to exactly that object
/// (`PreviousValue::MustExistAndMatch`), so a concurrent writer that moved the
/// ref out from under the caller makes the swap fail loudly rather than clobber
/// their commit. When `None`, the ref is set unconditionally
/// (`PreviousValue::Any`), matching the original force behavior.
///
/// The reflog identity is derived from the **committer of the commit the ref now
/// points at**, falling back to a stable `holo-tree` default for non-commit
/// targets or unreadable commits. It never reads ambient git config
/// (`user.name` / `user.email`). gix's convenience `reference()` does reach for
/// ambient config to stamp the reflog, and fails with "The reflog could not be
/// created or updated" when none is set — so an embedding consumer that supplies
/// a fully-specified commit (matching [`commit_tree`]'s explicit-identity
/// contract) could still see the *ref update* fail on an unconfigured runner.
/// Sourcing the identity from the commit itself keeps the whole operation
/// independent of machine config.
pub fn update_ref(
    repo: &gix::Repository,
    refname: &str,
    target: ObjectId,
    expected_old: Option<ObjectId>,
) -> Result<()> {
    use gix::refs::transaction::{Change, LogChange, RefEdit, RefLog};

    let qualified = qualify_ref(refname);
    let previous = match expected_old {
        Some(old) => gix::refs::transaction::PreviousValue::MustExistAndMatch(
            gix::refs::Target::Object(old),
        ),
        None => gix::refs::transaction::PreviousValue::Any,
    };

    let name: gix::refs::FullName = qualified
        .as_ref()
        .try_into()
        .map_err(|e: gix::refs::name::Error| Error::Git(e.to_string()))?;

    // Reflog identity: the target commit's committer, else a stable default.
    // Read the commit up front so its data outlives the borrowed `SignatureRef`
    // we hand to the transaction below.
    let commit = repo
        .find_object(target)
        .ok()
        .and_then(|obj| obj.try_into_commit().ok());
    let fallback = default_signature();
    let mut time_buf = gix::date::parse::TimeBuf::default();
    let committer = commit
        .as_ref()
        .and_then(|c| c.committer().ok())
        .unwrap_or_else(|| fallback.to_ref(&mut time_buf));

    let edit = RefEdit {
        change: Change::Update {
            log: LogChange {
                mode: RefLog::AndReference,
                force_create_reflog: false,
                message: "holo-tree".into(),
            },
            expected: previous,
            new: gix::refs::Target::Object(target),
        },
        name,
        deref: false,
    };

    repo.edit_references_as(Some(edit), Some(committer))
        .map_err(|e| Error::Git(e.to_string()))?;
    Ok(())
}

/// Map a bare branch name to a fully-qualified ref, matching `git update-ref`'s
/// leniency. See [`update_ref`].
fn qualify_ref(refname: &str) -> std::borrow::Cow<'_, str> {
    let is_pseudo_ref = !refname.is_empty()
        && refname
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'_');
    if refname.contains('/') || is_pseudo_ref {
        std::borrow::Cow::Borrowed(refname)
    } else {
        std::borrow::Cow::Owned(format!("refs/heads/{refname}"))
    }
}

/// Fallback signature when git config has no author/committer.
fn default_signature() -> gix::actor::Signature {
    gix::actor::SignatureRef {
        name: "holo-tree".into(),
        email: "holo-tree@localhost".into(),
        time: &format!(
            "{} +0000",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ),
    }
    .to_owned()
    .expect("valid fallback signature")
}

#[cfg(test)]
mod tests {
    use super::qualify_ref;

    #[test]
    fn qualifies_bare_branch_names() {
        assert_eq!(qualify_ref("main"), "refs/heads/main");
        assert_eq!(qualify_ref("feature-x"), "refs/heads/feature-x");
    }

    #[test]
    fn passes_through_qualified_and_pseudo_refs() {
        assert_eq!(qualify_ref("refs/heads/main"), "refs/heads/main");
        assert_eq!(qualify_ref("refs/tags/v1"), "refs/tags/v1");
        assert_eq!(qualify_ref("HEAD"), "HEAD");
        assert_eq!(qualify_ref("FETCH_HEAD"), "FETCH_HEAD");
    }
}
