//! Projection orchestrator: compose → strip metadata → write.

use gix::ObjectId;

use crate::branch;
use crate::config::{self, BranchConfig, BranchConfigFile, MappingConfig, WorkspaceConfigFile};
use crate::error::Result;
use holo_tree::{Context, MutableTree, TreeCache};

/// Project a holobranch by reading `.holo/` config from a git tree.
///
/// Returns the hash of the composed output tree.
///
/// Creates a fresh [`TreeCache`] for the run; recursive sub-projections share
/// it through the [`Context`]. Use [`project_branch_in`] to supply your own
/// context (e.g. to keep the cache warm across several projections).
pub fn project_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    let cache = TreeCache::new();
    let ctx = Context::new(repo, &cache);
    project_branch_in(&ctx, root_tree_id, branch_name)
}

/// [`project_branch`] against a caller-supplied [`Context`], so an embedding
/// consumer owns the cache and can reuse it across projections.
pub fn project_branch_in(
    ctx: &Context,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    compose_branch(ctx, root_tree_id, branch_name, true)
}

/// Compose a holobranch and return the **pre-lens tree**: the extends chain
/// and all mappings composed, `.holo/{branches,sources}` stripped, but the
/// final `.holo` strip **skipped** so `.holo/config.toml` and `.holo/lenses`
/// survive for a host-driven lens phase (`specs/api/projector-napi.md`).
///
/// This is the hybrid CLI's seam: it must be hash-identical to the JS
/// engine's post-composite state. Recursive sub-projections still run the
/// full pipeline ([`project_branch_in`]) — only the top level skips the
/// final strip, because only the top level gets lensed by the caller.
pub fn composite_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    let cache = TreeCache::new();
    let ctx = Context::new(repo, &cache);
    composite_branch_in(&ctx, root_tree_id, branch_name)
}

/// [`composite_branch`] against a caller-supplied [`Context`].
pub fn composite_branch_in(
    ctx: &Context,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    compose_branch(ctx, root_tree_id, branch_name, false)
}

fn compose_branch(
    ctx: &Context,
    root_tree_id: ObjectId,
    branch_name: &str,
    final_strip: bool,
) -> Result<ObjectId> {
    let mut ws_tree = MutableTree::new(root_tree_id);

    let ws_name = read_workspace_name(ctx, &mut ws_tree)?;

    let mut output = MutableTree::empty();

    // Resolve extends chain (base first)
    let chain = resolve_extends_chain(ctx, &mut ws_tree, branch_name)?;

    for name in &chain {
        branch::composite(
            ctx,
            &mut ws_tree,
            name,
            &ws_name,
            &mut output,
            &mut |c, tree_id, bn| project_branch_in(c, tree_id, bn),
        )?;
    }

    strip_branches_sources(ctx, &mut output)?;
    if final_strip {
        strip_bare_holo(ctx, &mut output)?;
    }

    Ok(output.write(ctx)?)
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
    let cache = TreeCache::new();
    let ctx = Context::new(repo, &cache);
    project_plan_in(&ctx, sources, mappings)
}

/// [`project_plan`] against a caller-supplied [`Context`].
pub fn project_plan_in(
    ctx: &Context,
    sources: &[crate::PlanSource],
    mappings: &[crate::PlanMapping],
) -> Result<ObjectId> {
    // Build a minimal workspace tree with just a config blob
    // so that self-source and recursive projections work.
    let ws_name = "plan";
    let mut ws_tree = MutableTree::empty();
    // Write .holo/config.toml so recursive projections can read it
    let config_blob = ctx
        .repo
        .write_blob(format!("[holospace]\nname = \"{ws_name}\"\n"))
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?;
    ws_tree.write_child_hash(ctx, ".holo/config.toml", config_blob.detach(), 0o100644)?;
    ws_tree.write(ctx)?;

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

        ws_tree.write_child(
            ctx,
            &format!(".holo/sources/{}.toml", src.name),
            &toml_content,
        )?;
    }
    ws_tree.write(ctx)?;

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
        ctx,
        &mapping_configs,
        ws_name,
        &mut ws_tree,
        &mut output,
        &mut |c, tree_id, bn| project_branch_in(c, tree_id, bn),
    )?;

    strip_branches_sources(ctx, &mut output)?;
    strip_bare_holo(ctx, &mut output)?;

    Ok(output.write(ctx)?)
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn read_workspace_name(ctx: &Context, tree: &mut MutableTree) -> Result<String> {
    let ws_config: Option<WorkspaceConfigFile> =
        config::read_toml(ctx, tree, ".holo/config.toml")?;
    Ok(ws_config
        .and_then(|c| c.holospace.name)
        .unwrap_or_default())
}

fn read_branch_config(
    ctx: &Context,
    tree: &mut MutableTree,
    name: &str,
) -> Result<BranchConfig> {
    let path = format!(".holo/branches/{name}.toml");
    match config::read_toml::<BranchConfigFile>(ctx, tree, &path)? {
        Some(f) => Ok(f.holobranch),
        None => Ok(BranchConfig::default()),
    }
}

/// Walk the `extend` chain and return branch names in base-first order.
fn resolve_extends_chain(
    ctx: &Context,
    tree: &mut MutableTree,
    start: &str,
) -> Result<Vec<String>> {
    let mut stack = vec![start.to_string()];
    let mut current = start.to_string();

    loop {
        let config = read_branch_config(ctx, tree, &current)?;
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

/// Strip `.holo/{branches,sources}` from output (the post-composite state
/// shared by both the full pipeline and the pre-lens seam).
fn strip_branches_sources(ctx: &Context, output: &mut MutableTree) -> Result<()> {
    if let Some(holo) = output.get_subtree(ctx, ".holo")? {
        holo.delete_child(ctx, "branches")?;
        holo.delete_child(ctx, "sources")?;
    }

    Ok(())
}

/// Strip `.holo` entirely if only `config.toml` remains (the final metadata
/// strip, applied after any lens phase would have run).
fn strip_bare_holo(ctx: &Context, output: &mut MutableTree) -> Result<()> {
    if let Some(holo) = output.get_subtree(ctx, ".holo")? {
        holo.ensure_children(ctx)?;
        let empty = holo
            .children
            .iter()
            .flatten()
            .all(|(name, _)| name == "config.toml");
        if empty {
            output.delete_child(ctx, ".holo")?;
        }
    }

    Ok(())
}
