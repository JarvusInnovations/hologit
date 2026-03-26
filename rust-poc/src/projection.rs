//! Projection engine — composes git trees by merging sources according to
//! holobranch mappings, following the same algorithm as Projection.js + Branch.composite().
//!
//! This PoC covers the composition phase (the main performance bottleneck).
//! Lensing is intentionally omitted — it shells out to containers anyway.

use anyhow::{bail, Context, Result};
use gix::bstr::ByteSlice;
use gix::ObjectId;
use topological_sort::TopologicalSort;

use crate::config::{
    self, BranchConfig, BranchConfigFile, MappingConfig, SourceConfig, SourceConfigFile,
};
use crate::tree::{MergeMode, MergeOptions, MutableTree};

/// Project a holobranch: composite all its mappings into a new output tree,
/// strip internal metadata, and write the result.
///
/// Returns the hash of the final output tree.
pub fn project_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId> {
    let mut workspace_tree = MutableTree::new(root_tree_id);

    // Read workspace config to get the workspace name (used for self-source)
    let ws_config: Option<config::WorkspaceConfigFile> =
        config::read_toml(repo, &mut workspace_tree, ".holo/config.toml")?;
    let workspace_name = ws_config
        .as_ref()
        .and_then(|c| c.holospace.name.as_deref())
        .unwrap_or("");

    // Create output tree (starts empty)
    let mut output = MutableTree::empty();

    // Handle branch extends chain
    let mut branch_stack: Vec<String> = Vec::new();
    let mut current_name = branch_name.to_string();

    loop {
        let branch_config = read_branch_config(repo, &mut workspace_tree, &current_name)?;
        match branch_config.extend {
            Some(ref extend_name) => {
                branch_stack.push(current_name.clone());
                current_name = extend_name.clone();
            }
            None => {
                branch_stack.push(current_name);
                break;
            }
        }
    }

    // Composite in reverse order (base first, then overrides)
    for name in branch_stack.into_iter().rev() {
        composite_branch(
            repo,
            &mut workspace_tree,
            &name,
            workspace_name,
            &mut output,
        )?;
    }

    // Strip .holo/{branches,sources} from output (same as Projection.composite)
    if let Some(holo) = output.get_subtree(repo, ".holo")? {
        holo.delete_child(repo, "branches")?;
        holo.delete_child(repo, "sources")?;
    }

    // Strip .holo/lenses from output
    if let Some(holo) = output.get_subtree(repo, ".holo")? {
        holo.delete_child(repo, "lenses")?;
    }

    // Strip .holo entirely if only config.toml remains
    strip_empty_holo(repo, &mut output)?;

    // Write the final tree to the ODB
    let hash = output.write(repo)?;
    Ok(hash)
}

/// Read a branch config, returning defaults if the TOML doesn't exist.
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

/// Composite a single branch's mappings into the output tree.
/// Equivalent to Branch.composite() in the JS codebase.
fn composite_branch(
    repo: &gix::Repository,
    workspace_tree: &mut MutableTree,
    branch_name: &str,
    workspace_name: &str,
    output: &mut MutableTree,
) -> Result<()> {
    // Discover and parse all mappings
    let mappings = config::discover_mappings(repo, workspace_tree, branch_name)?;

    if mappings.is_empty() {
        return Ok(());
    }

    // Topologically sort by before/after constraints
    let sorted = toposort_mappings(&mappings)?;

    eprintln!(
        "compositing {} mappings for holobranch '{}'",
        sorted.len(),
        branch_name
    );

    // Merge each mapping's source tree into the output
    for mapping in &sorted {
        eprintln!(
            "  merging {}:{}{{{:?}}} -> /{}",
            mapping.layer,
            if mapping.root == "." {
                String::new()
            } else {
                format!("{}/", mapping.root)
            },
            mapping.files,
            if mapping.output == "." {
                String::new()
            } else {
                format!("{}/", mapping.output)
            },
        );

        // Resolve source tree hash
        let source_tree_hash =
            resolve_source_tree(repo, workspace_tree, &mapping.holosource, workspace_name)?;

        // Load source tree at the mapping's root path
        let mut source_tree = if mapping.root == "." {
            MutableTree::new(source_tree_hash)
        } else {
            // Navigate to subtree: resolve "hash:path" like the JS does with createTreeFromRef
            resolve_tree_at_path(repo, source_tree_hash, &mapping.root)?
        };

        // Get or create the output subtree at the mapping's output path
        let target_tree = output.get_or_create_subtree(repo, &mapping.output)?;

        // Merge
        let merge_opts = MergeOptions::new(Some(&mapping.files), MergeMode::Overlay)?;
        target_tree.merge(repo, &mut source_tree, &merge_opts, ".")?;
    }

    Ok(())
}

/// Resolve a source to a tree hash.
///
/// In the full implementation this would handle:
/// - Remote fetching
/// - Working tree hashing
/// - Recursive projection (source.project.holobranch)
///
/// For this PoC, we resolve from gitlink entries in .holo/sources/
/// or treat workspace-name sources as the workspace root tree.
fn resolve_source_tree(
    repo: &gix::Repository,
    workspace_tree: &mut MutableTree,
    source_name: &str,
    workspace_name: &str,
) -> Result<ObjectId> {
    let (base_name, _holobranch) = match source_name.split_once("=>") {
        Some((base, branch)) => (base, Some(branch)),
        None => (source_name, None),
    };

    // Self-source: workspace tree is the source
    if base_name == workspace_name {
        // Write the workspace tree to get its hash
        // For self-source we need to return the tree hash
        return Ok(workspace_tree.hash);
    }

    // Read source config
    let source_config = read_source_config(repo, workspace_tree, base_name)?;

    // Try gitlink first
    if let Some(commit_hash) = config::resolve_gitlink(repo, workspace_tree, source_name)? {
        // Get tree hash from commit
        let tree_hash = commit_to_tree(repo, commit_hash)?;

        // If source has project config, recursively project
        if let Some(ref project) = source_config.project {
            eprintln!(
                "  (recursively projecting {} via holobranch {})",
                source_name, project.holobranch
            );
            return project_branch(repo, tree_hash, &project.holobranch);
        }

        return Ok(tree_hash);
    }

    // Try resolving from local ref
    if let Some(ref git_ref) = source_config.r#ref {
        if let Ok(resolved) = repo.rev_parse_single(git_ref.as_str()) {
            let obj = resolved.object()?;
            let commit = obj.try_into_commit()?;
            let tree_hash = commit.tree_id()?.detach();

            if let Some(ref project) = source_config.project {
                eprintln!(
                    "  (recursively projecting {} via holobranch {})",
                    source_name, project.holobranch
                );
                return project_branch(repo, tree_hash, &project.holobranch);
            }

            return Ok(tree_hash);
        }
    }

    bail!(
        "could not resolve source '{}' — no gitlink found and ref resolution failed.\n\
         (This PoC does not support remote fetching; ensure all sources are available locally.)",
        source_name
    );
}

fn read_source_config(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    name: &str,
) -> Result<SourceConfig> {
    let path = format!(".holo/sources/{name}.toml");
    match config::read_toml::<SourceConfigFile>(repo, tree, &path)? {
        Some(f) => Ok(f.holosource),
        None => {
            // Return empty config (source may be workspace self-ref or phantom)
            Ok(SourceConfig {
                url: None,
                r#ref: None,
                project: None,
            })
        }
    }
}

/// Get the tree OID from a commit OID.
fn commit_to_tree(repo: &gix::Repository, commit_id: ObjectId) -> Result<ObjectId> {
    let obj = repo
        .find_object(commit_id)
        .with_context(|| format!("failed to find commit {commit_id}"))?;
    let commit = obj
        .try_into_commit()
        .with_context(|| format!("{commit_id} is not a commit"))?;
    Ok(commit.tree_id()?.detach())
}

/// Navigate into a tree to a subpath and return a MutableTree for that subtree.
/// Equivalent to `repo.createTreeFromRef('hash:path')` in the JS code.
fn resolve_tree_at_path(
    repo: &gix::Repository,
    tree_id: ObjectId,
    path: &str,
) -> Result<MutableTree> {
    if path == "." || path.is_empty() {
        return Ok(MutableTree::new(tree_id));
    }

    let mut current_id = tree_id;

    for component in path.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }

        let obj = repo.find_object(current_id)?;
        let tree = obj.try_into_tree()?;

        let entry = tree
            .iter()
            .filter_map(|e| e.ok())
            .find(|e| {
                e.filename()
                    .to_str()
                    .map(|s| s == component)
                    .unwrap_or(false)
            })
            .with_context(|| format!("path component '{component}' not found in tree {current_id}"))?;

        current_id = entry.oid().to_owned();
    }

    Ok(MutableTree::new(current_id))
}

/// Topologically sort mappings by their before/after constraints.
/// Equivalent to the toposort logic in Branch.getMappings().
fn toposort_mappings(mappings: &[MappingConfig]) -> Result<Vec<MappingConfig>> {
    if mappings.is_empty() {
        return Ok(vec![]);
    }

    // Build layer→mapping index
    let mut by_layer: std::collections::HashMap<&str, Vec<usize>> =
        std::collections::HashMap::new();
    for (i, m) in mappings.iter().enumerate() {
        by_layer.entry(&m.layer).or_default().push(i);
    }

    // Build dependency graph
    let mut ts = TopologicalSort::<usize>::new();

    // Add all nodes
    for i in 0..mappings.len() {
        ts.insert(i);
    }

    for (i, mapping) in mappings.iter().enumerate() {
        // Process "after" constraints
        let mut after_expanded = mapping.after.clone();
        let mut j = 0;
        while j < after_expanded.len() {
            let after_layer = &after_expanded[j];
            if after_layer == "*" {
                // Expand wildcard: all other layers
                for layer in by_layer.keys() {
                    if *layer != mapping.layer && !after_expanded.contains(&layer.to_string()) {
                        after_expanded.push(layer.to_string());
                    }
                }
                j += 1;
                continue;
            }

            if let Some(indices) = by_layer.get(after_layer.as_str()) {
                for &dep_idx in indices {
                    ts.add_dependency(dep_idx, i); // dep must come before i
                }
            }
            j += 1;
        }

        // Process "before" constraints
        let mut before_expanded = mapping.before.clone();
        let mut j = 0;
        while j < before_expanded.len() {
            let before_layer = &before_expanded[j];
            if before_layer == "*" {
                for layer in by_layer.keys() {
                    if *layer != mapping.layer && !before_expanded.contains(&layer.to_string()) {
                        before_expanded.push(layer.to_string());
                    }
                }
                j += 1;
                continue;
            }

            if let Some(indices) = by_layer.get(before_layer.as_str()) {
                for &dep_idx in indices {
                    ts.add_dependency(i, dep_idx); // i must come before dep
                }
            }
            j += 1;
        }
    }

    // Extract sorted order
    let mut sorted = Vec::with_capacity(mappings.len());
    loop {
        let batch = ts.pop_all();
        if batch.is_empty() {
            break;
        }
        for idx in batch {
            sorted.push(mappings[idx].clone());
        }
    }

    if sorted.len() != mappings.len() {
        bail!("circular dependency detected in mapping before/after constraints");
    }

    Ok(sorted)
}

/// If .holo/ only contains config.toml, strip it from the output.
fn strip_empty_holo(repo: &gix::Repository, tree: &mut MutableTree) -> Result<()> {
    let holo = match tree.get_subtree(repo, ".holo")? {
        Some(t) => t,
        None => return Ok(()),
    };

    holo.ensure_children(repo)?;
    holo.ensure_children(repo)?;
    let children = holo.children.as_ref().unwrap();

    let mut empty = true;
    for (name, child) in children {
        if name != "config.toml" {
            match child {
                crate::tree::Child::Deleted => continue,
                _ => {
                    empty = false;
                    break;
                }
            }
        }
    }

    if empty {
        tree.delete_child(repo, ".holo")?;
    }

    Ok(())
}
