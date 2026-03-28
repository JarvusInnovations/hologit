//! Branch composition: discover mappings, toposort, and merge sources.

use std::collections::{HashMap, VecDeque};

use gix::ObjectId;

use crate::config::{self, MappingConfig};
use crate::error::{Error, Result};
use crate::source;
use holo_tree::{MergeMode, MergeOptions, MutableTree};

/// Composite a single branch's mappings into the output tree.
///
/// `project_fn` is passed through to source resolution for recursive
/// projections. It takes `(repo, tree_id, branch_name)` → tree hash.
pub fn composite(
    repo: &gix::Repository,
    workspace_tree: &mut MutableTree,
    branch_name: &str,
    workspace_name: &str,
    output: &mut MutableTree,
    project_fn: &mut dyn FnMut(&gix::Repository, ObjectId, &str) -> Result<ObjectId>,
) -> Result<()> {
    let mappings = config::discover_mappings(repo, workspace_tree, branch_name)?;
    if mappings.is_empty() {
        return Ok(());
    }

    let sorted = toposort(&mappings)?;

    for mapping in &sorted {
        // Resolve source → tree hash
        let source_tree_hash = source::resolve(
            repo,
            workspace_tree,
            &mapping.holosource,
            workspace_name,
            project_fn,
        )?;

        // Navigate to root subtree within source
        let mut source_tree = source::resolve_tree_at_path(repo, source_tree_hash, &mapping.root)?;

        // Navigate to (or create) output subtree
        let target = output.get_or_create_subtree(repo, &mapping.output)?;

        // Merge
        let opts = MergeOptions::new(Some(&mapping.files), MergeMode::Overlay)?;
        target.merge(repo, &mut source_tree, &opts, ".")?;
    }

    Ok(())
}

/// Composite from pre-built mapping configs (for the plan builder API).
///
/// Sources are resolved by name using the provided source configs,
/// which are looked up via `source_config_fn`.
pub fn composite_plan(
    repo: &gix::Repository,
    mappings: &[MappingConfig],
    workspace_name: &str,
    workspace_tree: &mut MutableTree,
    output: &mut MutableTree,
    project_fn: &mut dyn FnMut(&gix::Repository, ObjectId, &str) -> Result<ObjectId>,
) -> Result<()> {
    let sorted = toposort(mappings)?;

    for mapping in &sorted {
        let source_tree_hash = source::resolve(
            repo,
            workspace_tree,
            &mapping.holosource,
            workspace_name,
            project_fn,
        )?;

        let mut source_tree = source::resolve_tree_at_path(repo, source_tree_hash, &mapping.root)?;
        let target = output.get_or_create_subtree(repo, &mapping.output)?;
        let opts = MergeOptions::new(Some(&mapping.files), MergeMode::Overlay)?;
        target.merge(repo, &mut source_tree, &opts, ".")?;
    }

    Ok(())
}

// ── Topological sort ───────────────────────────────────────────────────────

/// Stable topological sort using Kahn's algorithm with a VecDeque queue.
///
/// Preserves input order for unconstrained nodes, matching the JS
/// `toposort.array()` behavior.
pub fn toposort(mappings: &[MappingConfig]) -> Result<Vec<MappingConfig>> {
    if mappings.is_empty() {
        return Ok(vec![]);
    }

    let n = mappings.len();

    // layer → indices
    let mut by_layer: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, m) in mappings.iter().enumerate() {
        by_layer.entry(&m.layer).or_default().push(i);
    }

    // Adjacency + in-degree
    let mut in_degree = vec![0usize; n];
    let mut dependents: Vec<Vec<usize>> = vec![vec![]; n];

    for (i, mapping) in mappings.iter().enumerate() {
        // "after" constraints: i comes after these layers
        let mut after = mapping.after.clone();
        expand_wildcard(&mut after, &mapping.layer, &by_layer);
        for layer_name in &after {
            if let Some(indices) = by_layer.get(layer_name.as_str()) {
                for &dep in indices {
                    if dep != i {
                        dependents[dep].push(i);
                        in_degree[i] += 1;
                    }
                }
            }
        }

        // "before" constraints: i comes before these layers
        let mut before = mapping.before.clone();
        expand_wildcard(&mut before, &mapping.layer, &by_layer);
        for layer_name in &before {
            if let Some(indices) = by_layer.get(layer_name.as_str()) {
                for &dep in indices {
                    if dep != i {
                        dependents[i].push(dep);
                        in_degree[dep] += 1;
                    }
                }
            }
        }
    }

    // Kahn's with VecDeque for stable ordering
    let mut queue = VecDeque::new();
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
        return Err(Error::CircularDependency {
            kind: "mapping before/after".into(),
        });
    }

    Ok(sorted)
}

/// Expand `*` wildcard to all other layer names.
fn expand_wildcard(
    list: &mut Vec<String>,
    own_layer: &str,
    by_layer: &HashMap<&str, Vec<usize>>,
) {
    let mut i = 0;
    while i < list.len() {
        if list[i] == "*" {
            for layer in by_layer.keys() {
                if *layer != own_layer && !list.contains(&layer.to_string()) {
                    list.push(layer.to_string());
                }
            }
            i += 1;
        } else {
            i += 1;
        }
    }
}
