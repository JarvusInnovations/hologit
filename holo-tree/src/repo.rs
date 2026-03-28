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

/// Create a git commit object pointing to a tree.
pub fn commit_tree(
    repo: &gix::Repository,
    tree_hash: ObjectId,
    parents: &[ObjectId],
    message: &str,
    author_name: &str,
    author_email: &str,
) -> Result<ObjectId> {
    use gix::objs::Commit;

    let sig = gix::actor::SignatureRef {
        name: author_name.into(),
        email: author_email.into(),
        time: &format!(
            "{} +0000",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ),
    };

    let commit = Commit {
        tree: tree_hash,
        parents: parents.into(),
        author: sig.to_owned().map_err(|e| Error::Git(e.to_string()))?,
        committer: sig.to_owned().map_err(|e| Error::Git(e.to_string()))?,
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
pub fn update_ref(
    repo: &gix::Repository,
    refname: &str,
    target: ObjectId,
) -> Result<()> {
    repo.reference(
        refname,
        target,
        gix::refs::transaction::PreviousValue::Any,
        "holo-tree",
    )
    .map_err(|e| Error::Git(e.to_string()))?;
    Ok(())
}
