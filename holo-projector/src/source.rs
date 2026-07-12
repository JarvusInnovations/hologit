//! Source resolution: resolve a holosource name to a tree hash.
//!
//! Sources have multiple resolution strategies tried in order:
//! self-source → gitlink → spec-ref → local ref → error.
//!
//! After resolving the base commit, optional projections are applied:
//! source.project.holobranch, then mapping holobranch (=>syntax).

use gix::ObjectId;

use crate::config::{self, SourceConfig, SourceConfigFile};
use crate::error::{Error, Result};
use holo_tree::{Context, MutableTree};

/// Resolve a source to a tree hash.
///
/// `project_fn` is called for recursive projections (source.project and
/// =>holobranch). It takes `(ctx, tree_id, branch_name)` and returns a
/// tree hash — this is `project_branch_in` passed as a callback to break the
/// circular dependency between source and projection.
pub fn resolve(
    ctx: &Context,
    workspace_tree: &mut MutableTree,
    source_name: &str,
    workspace_name: &str,
    project_fn: &mut dyn FnMut(&Context, ObjectId, &str) -> Result<ObjectId>,
) -> Result<ObjectId> {
    let (base_name, mapping_holobranch) = match source_name.split_once("=>") {
        Some((base, branch)) => (base, Some(branch)),
        None => (source_name, None),
    };

    // Self-source: workspace tree IS the source
    if base_name == workspace_name {
        let mut head = workspace_tree.hash;
        if let Some(hb) = mapping_holobranch {
            let projected = project_fn(ctx, head, hb)?;
            refuse_lensed_subprojection(ctx, head, hb, None, projected)?;
            head = projected;
        }
        return Ok(head);
    }

    // Read source config
    let source_config = read_source_config(ctx, workspace_tree, base_name)?;

    // Resolve commit via gitlink → spec-ref → local ref
    let commit = resolve_commit(ctx, workspace_tree, source_name, base_name, &source_config)?;

    // Peel to tree
    let mut head = commit_to_tree(ctx.repo, commit)?;

    // Apply source.project.holobranch
    if let Some(ref project) = source_config.project {
        let projected = project_fn(ctx, head, &project.holobranch)?;
        refuse_lensed_subprojection(ctx, head, &project.holobranch, project.lens, projected)?;
        head = projected;
    }

    // Apply mapping holobranch (=>syntax)
    if let Some(hb) = mapping_holobranch {
        let projected = project_fn(ctx, head, hb)?;
        refuse_lensed_subprojection(ctx, head, hb, None, projected)?;
        head = projected;
    }

    Ok(head)
}

// ── Sub-projection lensing guard ───────────────────────────────────────────

/// Refuse a recursive sub-projection whose lensing would alter output
/// (`specs/behaviors/composition.md` § Sub-projection lensing).
///
/// The legacy engine lenses a sub-projection when its **effective lens
/// flag** is true: the sub-branch config's `lens` when boolean, else the
/// source's `project.lens` when boolean (`default_lens`), else `true`. This
/// engine is composition-only, so when the flag is true *and* any lens
/// actually exists — external configs under
/// `.holo/branches/<branch>.lenses/*.toml` in the sub-workspace, or internal
/// configs at `.holo/lenses/*.toml` in the composited output — silently
/// skipping the lens phase would produce a wrong hash. Refusing with a
/// matchable error (`LENSED_SUBPROJECTION`) lets a host fall back to an
/// engine that lenses.
fn refuse_lensed_subprojection(
    ctx: &Context,
    workspace_tree_id: ObjectId,
    branch_name: &str,
    default_lens: Option<bool>,
    output_tree_id: ObjectId,
) -> Result<()> {
    let mut ws_tree = MutableTree::new(workspace_tree_id);

    let branch_config = config::read_toml::<crate::config::BranchConfigFile>(
        ctx,
        &mut ws_tree,
        &format!(".holo/branches/{branch_name}.toml"),
    )?;
    let effective_lens = branch_config
        .and_then(|f| f.holobranch.lens)
        .or(default_lens)
        .unwrap_or(true);

    if !effective_lens {
        return Ok(());
    }

    if has_toml_blob(ctx, &mut ws_tree, &format!(".holo/branches/{branch_name}.lenses"))? {
        return Err(Error::LensedSubprojection {
            branch: branch_name.to_string(),
            reason: "external lens configs present in sub-workspace".into(),
        });
    }

    let mut output_tree = MutableTree::new(output_tree_id);
    if has_toml_blob(ctx, &mut output_tree, ".holo/lenses")? {
        return Err(Error::LensedSubprojection {
            branch: branch_name.to_string(),
            reason: "internal lens configs present in composited output".into(),
        });
    }

    Ok(())
}

/// Does the subtree at `path` contain any direct `*.toml` blob child?
/// Mirrors the legacy engine's lens discovery (`Branch.getLenses` /
/// `Workspace.getLenses`): only direct blob children named `*.toml` count.
fn has_toml_blob(ctx: &Context, tree: &mut MutableTree, path: &str) -> Result<bool> {
    let subtree = match tree.get_subtree(ctx, path)? {
        Some(t) => t,
        None => return Ok(false),
    };
    subtree.ensure_children(ctx)?;
    Ok(subtree.children.iter().flatten().any(|(name, child)| {
        name.ends_with(".toml")
            && !name.trim_end_matches(".toml").is_empty()
            && matches!(child, holo_tree::Child::Blob { .. })
    }))
}

// ── Commit resolution ──────────────────────────────────────────────────────

fn resolve_commit(
    ctx: &Context,
    workspace_tree: &mut MutableTree,
    source_name: &str,
    base_name: &str,
    config: &SourceConfig,
) -> Result<ObjectId> {
    // 1. Gitlink
    if let Some(hash) = config::resolve_gitlink(ctx, workspace_tree, source_name)? {
        return Ok(hash);
    }
    if base_name != source_name {
        if let Some(hash) = config::resolve_gitlink(ctx, workspace_tree, base_name)? {
            return Ok(hash);
        }
    }

    // 2. Spec ref
    if let Some(ref url) = config.url {
        if let Some(ref git_ref) = config.git_ref {
            let spec_hash = compute_spec_hash(url)?;
            let suffix = git_ref.strip_prefix("refs/").unwrap_or(git_ref);
            let spec_ref = format!(
                "refs/holo/source/{}/{}/{}",
                &spec_hash[..2],
                &spec_hash[2..],
                suffix
            );

            if let Ok(resolved) = ctx.repo.rev_parse_single(spec_ref.as_str()) {
                return peel_to_commit(ctx.repo, resolved.detach());
            }
        }
    }

    // 3. Local ref
    if let Some(ref git_ref) = config.git_ref {
        if let Ok(resolved) = ctx.repo.rev_parse_single(git_ref.as_str()) {
            return peel_to_commit(ctx.repo, resolved.detach());
        }
    }

    Err(Error::SourceResolution {
        name: source_name.to_string(),
        reason: "no gitlink, spec-ref, or local ref resolved".into(),
    })
}

fn read_source_config(
    ctx: &Context,
    tree: &mut MutableTree,
    name: &str,
) -> Result<SourceConfig> {
    let path = format!(".holo/sources/{name}.toml");
    match config::read_toml::<SourceConfigFile>(ctx, tree, &path)? {
        Some(f) => Ok(f.holosource),
        None => Ok(SourceConfig::default()),
    }
}

// ── Object helpers ─────────────────────────────────────────────────────────

/// Get the tree OID from a commit, peeling tags if needed.
fn commit_to_tree(repo: &gix::Repository, id: ObjectId) -> Result<ObjectId> {
    let mut obj = repo.find_object(id)?;

    while obj.kind == gix::object::Kind::Tag {
        let tag = obj
            .try_into_tag()
            .map_err(|_| holo_tree::Error::Git(format!("{id} failed to parse as tag")))?;
        let target = tag
            .target_id()
            .map_err(|e| holo_tree::Error::Git(e.to_string()))?
            .detach();
        obj = repo.find_object(target)?;
    }

    let commit = obj
        .try_into_commit()
        .map_err(|_| holo_tree::Error::Git(format!("{id} does not peel to a commit")))?;
    let tree_id = commit
        .tree_id()
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?
        .detach();
    Ok(tree_id)
}

/// Peel an object to a commit OID (handles tags).
fn peel_to_commit(repo: &gix::Repository, id: ObjectId) -> Result<ObjectId> {
    let mut obj = repo.find_object(id)?;
    while obj.kind == gix::object::Kind::Tag {
        let tag = obj
            .try_into_tag()
            .map_err(|_| holo_tree::Error::Git(format!("{id} failed to parse as tag")))?;
        let target = tag
            .target_id()
            .map_err(|e| holo_tree::Error::Git(e.to_string()))?
            .detach();
        obj = repo.find_object(target)?;
    }
    Ok(obj.id().detach())
}

// ── Spec hash ──────────────────────────────────────────────────────────────

/// Compute the spec hash for a source URL.
///
/// Must produce byte-identical TOML to the JS implementation
/// so that spec refs written by JS can be resolved by Rust.
pub fn compute_spec_hash(url: &str) -> Result<String> {
    let (host, path) = parse_url(url);

    // Keys must be alphabetically sorted (host before path)
    let toml = match host {
        Some(ref h) => format!("[holospec.source]\nhost = \"{h}\"\npath = \"{path}\"\n"),
        None => format!("[holospec.source]\npath = \"{path}\"\n"),
    };

    let header = format!("blob {}\0", toml.len());
    let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
    hasher.update(header.as_bytes());
    hasher.update(toml.as_bytes());
    let oid = hasher.try_finalize().map_err(|e| holo_tree::Error::Git(e.to_string()))?;
    Ok(oid.to_string())
}

/// Parse a URL to extract (host, path), matching JS `parse-url` behavior.
fn parse_url(raw: &str) -> (Option<String>, String) {
    let effective = if raw.starts_with('/') {
        format!("file://{raw}")
    } else {
        raw.to_string()
    };

    // Standard URL
    if let Ok(parsed) = url::Url::parse(&effective) {
        let host = parsed.host_str().map(|h| h.to_lowercase());
        let path = parsed
            .path()
            .to_lowercase()
            .trim_end_matches(".git")
            .trim_end_matches('/')
            .to_string();
        return (host, path);
    }

    // SSH-style: git@github.com:org/repo.git
    if effective.contains(':') && !effective.contains("://") {
        let parts: Vec<&str> = effective.splitn(2, ':').collect();
        let host = parts[0]
            .rsplit('@')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let path = format!(
            "/{}",
            parts
                .get(1)
                .unwrap_or(&"")
                .to_lowercase()
                .trim_end_matches(".git")
                .trim_end_matches('/')
        );
        return (Some(host), path);
    }

    (None, ".".to_string())
}

/// Navigate into a tree at a given subpath.
/// Delegates to `holo_tree::repo::create_tree_from_path`.
pub fn resolve_tree_at_path(
    repo: &gix::Repository,
    tree_id: ObjectId,
    path: &str,
) -> Result<MutableTree> {
    Ok(holo_tree::repo::create_tree_from_path(repo, tree_id, path)?)
}
