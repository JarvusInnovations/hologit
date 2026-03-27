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

    // Note: .holo/lenses is only stripped when lensing runs (Projection.lens),
    // which this PoC does not implement. Leave it in the output.

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
/// Handles: gitlinks, spec-ref resolution, source.project.holobranch,
/// and mapping holobranch (source=>holobranch syntax).
fn resolve_source_tree(
    repo: &gix::Repository,
    workspace_tree: &mut MutableTree,
    source_name: &str,
    workspace_name: &str,
) -> Result<ObjectId> {
    let (base_name, mapping_holobranch) = match source_name.split_once("=>") {
        Some((base, branch)) => (base, Some(branch)),
        None => (source_name, None),
    };

    // Self-source: workspace tree is the source
    if base_name == workspace_name {
        let mut head = workspace_tree.hash;
        // Apply mapping holobranch if present
        if let Some(holobranch) = mapping_holobranch {
            eprintln!(
                "  (projecting {} via mapping holobranch {})",
                source_name, holobranch
            );
            head = project_branch(repo, head, holobranch)?;
        }
        return Ok(head);
    }

    // Read source config
    let source_config = read_source_config(repo, workspace_tree, base_name)?;

    // Resolve the source commit hash via multiple strategies
    let commit_hash = resolve_source_commit(repo, workspace_tree, source_name, base_name, &source_config)?;

    // Get tree from commit
    let mut head = commit_to_tree(repo, commit_hash)?;

    // Apply source.project.holobranch if configured
    if let Some(ref project) = source_config.project {
        eprintln!(
            "  (recursively projecting {} via source holobranch {})",
            source_name, project.holobranch
        );
        head = project_branch(repo, head, &project.holobranch)?;
    }

    // Apply mapping holobranch (=>holobranch) if present
    if let Some(holobranch) = mapping_holobranch {
        eprintln!(
            "  (projecting {} via mapping holobranch {})",
            source_name, holobranch
        );
        head = project_branch(repo, head, holobranch)?;
    }

    Ok(head)
}

/// Resolve a source's commit hash via gitlink, spec-ref, or local ref.
fn resolve_source_commit(
    repo: &gix::Repository,
    workspace_tree: &mut MutableTree,
    source_name: &str,
    base_name: &str,
    source_config: &SourceConfig,
) -> Result<ObjectId> {
    // Try gitlink first
    if let Some(commit_hash) = config::resolve_gitlink(repo, workspace_tree, source_name)? {
        return Ok(commit_hash);
    }
    // Also try base_name gitlink (without =>holobranch suffix)
    if base_name != source_name {
        if let Some(commit_hash) = config::resolve_gitlink(repo, workspace_tree, base_name)? {
            return Ok(commit_hash);
        }
    }

    // Try spec ref
    if let Some(ref url) = source_config.url {
        if let Some(ref git_ref) = source_config.r#ref {
            let spec_hash = compute_source_spec_hash(repo, url)?;
            let ref_suffix = git_ref.strip_prefix("refs/").unwrap_or(git_ref);
            let spec_ref = format!(
                "refs/holo/source/{}/{}/{}",
                &spec_hash[..2],
                &spec_hash[2..],
                ref_suffix
            );

            if let Ok(resolved) = repo.rev_parse_single(spec_ref.as_str()) {
                return peel_to_commit(repo, resolved.detach());
            }
        }
    }

    // Try local ref directly
    if let Some(ref git_ref) = source_config.r#ref {
        if let Ok(resolved) = repo.rev_parse_single(git_ref.as_str()) {
            return peel_to_commit(repo, resolved.detach());
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

/// Compute the spec hash for a source URL.
/// Replicates the JS logic: parse URL → extract host+path → build canonical TOML → SHA-1 as git blob.
fn compute_source_spec_hash(repo: &gix::Repository, url: &str) -> Result<String> {
    // Parse URL to extract host and path (matching parse-url behavior)
    let (host, path) = parse_source_url(url);

    // Build canonical TOML (keys sorted alphabetically: host before path)
    let toml = if let Some(ref h) = host {
        format!(
            "[holospec.source]\nhost = \"{}\"\npath = \"{}\"\n",
            h, path
        )
    } else {
        format!("[holospec.source]\npath = \"{}\"\n", path)
    };

    // Hash as git blob: "blob {len}\0{content}"
    let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
    let header = format!("blob {}\0", toml.len());
    hasher.update(header.as_bytes());
    hasher.update(toml.as_bytes());
    let oid = hasher.try_finalize()?;
    Ok(oid.to_string())
}

/// Parse a source URL to extract host and path, matching the JS parse-url behavior.
fn parse_source_url(url: &str) -> (Option<String>, String) {
    // Handle file:// or absolute paths
    let effective_url = if url.starts_with('/') {
        format!("file://{url}")
    } else {
        url.to_string()
    };

    // Try to parse as URL
    if let Ok(parsed) = url::Url::parse(&effective_url) {
        let host = parsed.host_str().map(|h| h.to_lowercase());
        let path = parsed
            .path()
            .to_lowercase()
            .trim_end_matches(".git")
            .trim_end_matches('/')
            .to_string();
        (host, path)
    } else if effective_url.contains(':') && !effective_url.contains("://") {
        // SSH-style: git@github.com:org/repo.git
        let parts: Vec<&str> = effective_url.splitn(2, ':').collect();
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
        (Some(host), path)
    } else {
        (None, ".".to_string())
    }
}

/// Get the tree OID from a commit (or tag→commit) OID.
/// Handles tag peeling: tag → commit → tree.
fn commit_to_tree(repo: &gix::Repository, object_id: ObjectId) -> Result<ObjectId> {
    let mut obj = repo
        .find_object(object_id)
        .with_context(|| format!("failed to find object {object_id}"))?;

    // Peel tags to get to the commit
    while obj.kind == gix::object::Kind::Tag {
        let tag = obj.try_into_tag()?;
        let target_id = tag.target_id()?.detach();
        obj = repo.find_object(target_id)?;
    }

    let commit = obj
        .try_into_commit()
        .with_context(|| format!("{object_id} does not peel to a commit"))?;
    Ok(commit.tree_id()?.detach())
}

/// Peel an object to a commit OID (handles tags).
fn peel_to_commit(repo: &gix::Repository, object_id: ObjectId) -> Result<ObjectId> {
    let mut obj = repo
        .find_object(object_id)
        .with_context(|| format!("failed to find object {object_id}"))?;

    while obj.kind == gix::object::Kind::Tag {
        let tag = obj.try_into_tag()?;
        let target_id = tag.target_id()?.detach();
        obj = repo.find_object(target_id)?;
    }

    Ok(obj.id().detach())
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
/// Uses Kahn's algorithm with a stable queue (VecDeque) to preserve
/// input order for unconstrained nodes — matching the JS toposort behavior.
fn toposort_mappings(mappings: &[MappingConfig]) -> Result<Vec<MappingConfig>> {
    if mappings.is_empty() {
        return Ok(vec![]);
    }

    let n = mappings.len();

    // Build layer→mapping index
    let mut by_layer: std::collections::HashMap<&str, Vec<usize>> =
        std::collections::HashMap::new();
    for (i, m) in mappings.iter().enumerate() {
        by_layer.entry(&m.layer).or_default().push(i);
    }

    // Build adjacency list and in-degree counts (Kahn's algorithm)
    let mut in_degree = vec![0usize; n];
    let mut dependents: Vec<Vec<usize>> = vec![vec![]; n]; // dependents[i] = nodes that depend on i

    for (i, mapping) in mappings.iter().enumerate() {
        // "after" constraints: i must come after these layers
        let mut after_expanded = mapping.after.clone();
        let mut j = 0;
        while j < after_expanded.len() {
            if after_expanded[j] == "*" {
                for layer in by_layer.keys() {
                    if *layer != mapping.layer && !after_expanded.contains(&layer.to_string()) {
                        after_expanded.push(layer.to_string());
                    }
                }
                j += 1;
                continue;
            }

            if let Some(indices) = by_layer.get(after_expanded[j].as_str()) {
                for &dep_idx in indices {
                    if dep_idx != i {
                        dependents[dep_idx].push(i);
                        in_degree[i] += 1;
                    }
                }
            }
            j += 1;
        }

        // "before" constraints: i must come before these layers
        let mut before_expanded = mapping.before.clone();
        let mut j = 0;
        while j < before_expanded.len() {
            if before_expanded[j] == "*" {
                for layer in by_layer.keys() {
                    if *layer != mapping.layer && !before_expanded.contains(&layer.to_string()) {
                        before_expanded.push(layer.to_string());
                    }
                }
                j += 1;
                continue;
            }

            if let Some(indices) = by_layer.get(before_expanded[j].as_str()) {
                for &dep_idx in indices {
                    if dep_idx != i {
                        dependents[i].push(dep_idx);
                        in_degree[dep_idx] += 1;
                    }
                }
            }
            j += 1;
        }
    }

    // Kahn's with VecDeque for stable ordering (preserves input order)
    let mut queue = std::collections::VecDeque::new();
    for i in 0..n {
        if in_degree[i] == 0 {
            queue.push_back(i);
        }
    }

    let mut sorted = Vec::with_capacity(n);
    while let Some(idx) = queue.pop_front() {
        sorted.push(mappings[idx].clone());
        for &dep in &dependents[idx] {
            in_degree[dep] -= 1;
            if in_degree[dep] == 0 {
                queue.push_back(dep);
            }
        }
    }

    if sorted.len() != n {
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
