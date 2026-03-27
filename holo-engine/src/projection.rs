//! Projection orchestrator: compose → strip metadata → write.

use gix::ObjectId;

use crate::branch;
use crate::config::{self, BranchConfig, BranchConfigFile, MappingConfig, WorkspaceConfigFile};
use crate::error::Result;
use crate::tree::{Child, MutableTree};

/// Project a holobranch by reading `.holo/` config from a git tree.
///
/// Returns the hash of the composed output tree.
pub fn project_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    let mut ws_tree = MutableTree::new(root_tree_id);

    let ws_name = read_workspace_name(repo, &mut ws_tree)?;

    let mut output = MutableTree::empty();

    // Resolve extends chain (base first)
    let chain = resolve_extends_chain(repo, &mut ws_tree, branch_name)?;

    for name in &chain {
        branch::composite(
            repo,
            &mut ws_tree,
            name,
            &ws_name,
            &mut output,
            &mut |r, tree_id, bn| project_branch(r, tree_id, bn),
        )?;
    }

    strip_metadata(repo, &mut output)?;

    output.write(repo)
}

/// Compose git trees from structured source/mapping definitions.
/// No `.holo/` directory needed — config is passed directly.
///
/// This is the entry point for the `ProjectionPlan` builder API.
pub fn project_plan(
    repo: &gix::Repository,
    sources: &[crate::PlanSource],
    mappings: &[crate::PlanMapping],
) -> Result<ObjectId> {
    // Build a minimal workspace tree with just a config blob
    // so that self-source and recursive projections work.
    let ws_name = "plan";
    let mut ws_tree = MutableTree::empty();
    // Write .holo/config.toml so recursive projections can read it
    let config_blob = repo
        .write_blob(format!("[holospace]\nname = \"{ws_name}\"\n"))
        .map_err(|e| crate::error::Error::Git(e.to_string()))?;
    {
        let holo = ws_tree.get_or_create_subtree(repo, ".holo")?;
        holo.ensure_children(repo)?;
        holo.children.as_mut().unwrap().insert(
            "config.toml".to_string(),
            Child::Blob {
                mode: 0o100644,
                hash: config_blob.detach(),
            },
        );
        holo.dirty = true;
    }
    ws_tree.dirty = true;
    ws_tree.write(repo)?;

    // Write source config blobs into the workspace tree so that
    // source::resolve can read them via read_source_config
    for src in sources {
        let mut toml_content = String::from("[holosource]\n");
        if let Some(ref url) = src.url {
            toml_content.push_str(&format!("url = \"{url}\"\n"));
        }
        if let Some(ref git_ref) = src.git_ref {
            toml_content.push_str(&format!("ref = \"{git_ref}\"\n"));
        }
        if let Some(ref hb) = src.project_holobranch {
            toml_content.push_str(&format!("\n[holosource.project]\nholobranch = \"{hb}\"\n"));
        }

        let blob_id = repo
            .write_blob(&toml_content)
            .map_err(|e| crate::error::Error::Git(e.to_string()))?;

        let sources_tree = ws_tree.get_or_create_subtree(repo, ".holo/sources")?;
        sources_tree.children.as_mut().unwrap().insert(
            format!("{}.toml", src.name),
            Child::Blob {
                mode: 0o100644,
                hash: blob_id.detach(),
            },
        );
        sources_tree.dirty = true;
    }
    ws_tree.dirty = true;
    ws_tree.write(repo)?;

    // Convert PlanMappings to MappingConfigs
    let mapping_configs: Vec<MappingConfig> = mappings
        .iter()
        .map(|m| MappingConfig {
            key: format!("_{}", m.source),
            holosource: m.source.clone(),
            files: m.files.clone(),
            root: m.root.clone(),
            output: m.output.clone(),
            layer: m.layer.clone(),
            before: m.before.clone(),
            after: m.after.clone(),
        })
        .collect();

    let mut output = MutableTree::empty();

    branch::composite_plan(
        repo,
        &mapping_configs,
        ws_name,
        &mut ws_tree,
        &mut output,
        &mut |r, tree_id, bn| project_branch(r, tree_id, bn),
    )?;

    strip_metadata(repo, &mut output)?;

    output.write(repo)
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn read_workspace_name(repo: &gix::Repository, tree: &mut MutableTree) -> Result<String> {
    let ws_config: Option<WorkspaceConfigFile> =
        config::read_toml(repo, tree, ".holo/config.toml")?;
    Ok(ws_config
        .and_then(|c| c.holospace.name)
        .unwrap_or_default())
}

fn read_branch_config(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    name: &str,
) -> Result<BranchConfig> {
    let path = format!(".holo/branches/{name}.toml");
    match config::read_toml::<BranchConfigFile>(repo, tree, &path)? {
        Some(f) => Ok(f.holobranch),
        None => Ok(BranchConfig::default()),
    }
}

/// Walk the `extend` chain and return branch names in base-first order.
fn resolve_extends_chain(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    start: &str,
) -> Result<Vec<String>> {
    let mut stack = vec![start.to_string()];
    let mut current = start.to_string();

    loop {
        let config = read_branch_config(repo, tree, &current)?;
        match config.extend {
            Some(ref ext) => {
                stack.push(ext.clone());
                current = ext.clone();
            }
            None => break,
        }
    }

    stack.reverse(); // base first
    Ok(stack)
}

/// Strip `.holo/{branches,sources}` from output, then strip `.holo`
/// entirely if only `config.toml` remains.
fn strip_metadata(repo: &gix::Repository, output: &mut MutableTree) -> Result<()> {
    if let Some(holo) = output.get_subtree(repo, ".holo")? {
        holo.delete_child(repo, "branches")?;
        holo.delete_child(repo, "sources")?;
    }

    // Strip .holo if only config.toml remains
    if let Some(holo) = output.get_subtree(repo, ".holo")? {
        holo.ensure_children(repo)?;
        let children = holo.children.as_ref().unwrap();
        let empty = children
            .iter()
            .all(|(name, _)| name == "config.toml");
        if empty {
            output.delete_child(repo, ".holo")?;
        }
    }

    Ok(())
}
