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
/// Uses the repository's configured author/committer identity (from
/// git config or `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` env vars).
/// Falls back to "holo-tree" if no identity is configured.
pub fn commit_tree(
    repo: &gix::Repository,
    tree_hash: ObjectId,
    parents: &[ObjectId],
    message: &str,
) -> Result<ObjectId> {
    use gix::objs::Commit;

    let author = repo
        .author()
        .and_then(|r| r.ok())
        .map(|s| s.to_owned())
        .transpose()
        .ok()
        .flatten()
        .unwrap_or_else(default_signature);

    let committer = repo
        .committer()
        .and_then(|r| r.ok())
        .map(|s| s.to_owned())
        .transpose()
        .ok()
        .flatten()
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

/// Update a git ref to point at a new object.
///
/// Accepts the same leniency as `git update-ref`: a bare branch name (e.g.
/// `main`) is qualified to `refs/heads/main`. Already-qualified names (anything
/// containing `/`, like `refs/heads/x` or `refs/tags/x`) and all-caps pseudo-refs
/// (e.g. `HEAD`) pass through unchanged. Without this, gix's `reference()`
/// rejects a standalone lowercase name ("Standalone references must be all
/// uppercased").
pub fn update_ref(
    repo: &gix::Repository,
    refname: &str,
    target: ObjectId,
) -> Result<()> {
    let qualified = qualify_ref(refname);
    repo.reference(
        qualified.as_ref(),
        target,
        gix::refs::transaction::PreviousValue::Any,
        "holo-tree",
    )
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
