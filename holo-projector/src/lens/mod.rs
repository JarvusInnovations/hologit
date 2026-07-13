//! Lens (hololens) execution: the edge capability layered around pure
//! composition (`specs/behaviors/lensing.md`).
//!
//! Composition never executes lenses; this module wraps composition output:
//! build the glob-filtered input tree, resolve the container identity,
//! compute the content-addressed spec hash, satisfy from the spec-keyed
//! cache (`refs/holo/lens/…`) or execute the container over the v2 one-shot
//! job protocol, and merge the result back per the lens's declared output
//! mode. Spec hashing and cache refs are hash/byte-identical with the JS
//! engine, so cache entries interoperate across engines in both directions.
//!
//! Entry point: [`project_branch_lensed`] — the full oracle pipeline
//! (`Projection.projectBranch`): composite → lens → final metadata strip.
//! Recursive sub-projections lens natively per their effective lens flag
//! (`specs/behaviors/composition.md` § Sub-projection lensing) instead of
//! refusing with `LENSED_SUBPROJECTION` as the composition-only entry points
//! do.

pub mod iarna;
pub mod identity;
pub mod job;
pub mod runtime;
pub mod spec;
pub mod toposort;

use std::time::Duration;

use gix::ObjectId;

use crate::config::BranchConfigFile;
use crate::error::{Error, Result};
use crate::projection;
use holo_tree::{Child, Context, MergeMode, MergeOptions, MutableTree, TreeCache};

pub use identity::ContainerIdentity;
pub use runtime::{ContainerCli, ContainerRuntime, CurlRegistry, RegistryClient};
pub use spec::LensConfig;

/// The lens engine: the container runtime + registry seams plus execution
/// policy. Composition stays pure; everything side-effecting about lensing
/// flows through this.
pub struct LensEngine<'a> {
    pub runtime: &'a dyn ContainerRuntime,
    pub registry: &'a dyn RegistryClient,
    /// Optional remote-source fetcher, inherited by the composition phase
    /// and recursive sub-projections (`specs/behaviors/source-resolution.md`).
    pub fetcher: Option<&'a dyn crate::fetch::SourceFetcher>,
    /// Re-execute even when a cached result exists.
    pub refresh: bool,
    /// Record results at the spec-keyed cache ref.
    pub save: bool,
}

impl<'a> LensEngine<'a> {
    pub fn new(
        runtime: &'a dyn ContainerRuntime,
        registry: &'a dyn RegistryClient,
    ) -> LensEngine<'a> {
        LensEngine {
            runtime,
            registry,
            fetcher: None,
            refresh: false,
            save: true,
        }
    }
}

// ── Public pipeline ────────────────────────────────────────────────────────

/// Project a holobranch through the full pipeline: composite, lens (when the
/// effective lens flag allows), strip metadata, write. Returns the final
/// output tree hash — identical to the JS engine's for the same input.
///
/// `lens_override` mirrors the oracle's `lens` option: `Some(_)` overrides
/// the branch config's `lens` flag; `None` defers to config, defaulting to
/// `true`. Sub-projections always resolve their own effective flag.
pub fn project_branch_lensed(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
    engine: &LensEngine<'_>,
    lens_override: Option<bool>,
) -> Result<ObjectId> {
    let cache = TreeCache::new();
    let ctx = Context::new(repo, &cache);
    let lens_phase = match lens_override {
        Some(flag) => flag,
        None => read_branch_lens_flag(&ctx, root_tree_id, branch_name)?.unwrap_or(true),
    };
    lensed_pipeline(&ctx, root_tree_id, branch_name, engine, lens_phase)
}

/// Recursive sub-projection with native lensing: the effective lens flag is
/// the sub-branch config's `lens` when boolean, else the caller's default
/// (`holosource.project.lens`), else `true` — exactly the oracle's
/// `Source.getOutputTree` resolution.
fn lensed_sub_projection(
    ctx: &Context,
    root_tree_id: ObjectId,
    branch_name: &str,
    engine: &LensEngine<'_>,
    default_lens: Option<bool>,
) -> Result<ObjectId> {
    let lens_phase = read_branch_lens_flag(ctx, root_tree_id, branch_name)?
        .or(default_lens)
        .unwrap_or(true);
    lensed_pipeline(ctx, root_tree_id, branch_name, engine, lens_phase)
}

fn lensed_pipeline(
    ctx: &Context,
    root_tree_id: ObjectId,
    branch_name: &str,
    engine: &LensEngine<'_>,
    lens_phase: bool,
) -> Result<ObjectId> {
    let mut project_fn = |c: &Context, tree_id: ObjectId, bn: &str, default_lens: Option<bool>| {
        lensed_sub_projection(c, tree_id, bn, engine, default_lens)
    };

    let mut output = projection::compose_branch_tree(
        ctx,
        root_tree_id,
        branch_name,
        &mut project_fn,
        engine.fetcher,
    )?;

    if lens_phase {
        apply_lenses(ctx, engine, &mut output, root_tree_id, branch_name)?;
    }

    projection::strip_bare_holo(ctx, &mut output)?;
    Ok(output.write(ctx)?)
}

fn read_branch_lens_flag(
    ctx: &Context,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<Option<bool>> {
    let mut ws_tree = MutableTree::new(root_tree_id);
    let config = crate::config::read_toml::<BranchConfigFile>(
        ctx,
        &mut ws_tree,
        &format!(".holo/branches/{branch_name}.toml"),
    )?;
    Ok(config.and_then(|f| f.holobranch.lens))
}

// ── Lens phase ─────────────────────────────────────────────────────────────

/// Apply a projection's lenses to its composed output tree
/// (`Projection.lens`): internal lens configs (`.holo/lenses/*.toml` in the
/// composed output) run first, then external ones
/// (`.holo/branches/<branch>.lenses/*.toml` in the input workspace), each
/// group ordered by its `before`/`after` constraints. Ends by stripping
/// `.holo/lenses` from the output.
pub fn apply_lenses(
    ctx: &Context,
    engine: &LensEngine<'_>,
    output: &mut MutableTree,
    branch_root_tree: ObjectId,
    branch_name: &str,
) -> Result<()> {
    let internal = discover_lenses(ctx, output, ".holo/lenses")?;

    let mut ws_tree = MutableTree::new(branch_root_tree);
    let external = discover_lenses(
        ctx,
        &mut ws_tree,
        &format!(".holo/branches/{branch_name}.lenses"),
    )?;

    for lens in internal.iter().chain(external.iter()) {
        run_lens(ctx, engine, output, lens)?;
    }

    if let Some(holo) = output.get_subtree(ctx, ".holo")? {
        holo.delete_child(ctx, "lenses")?;
    }

    Ok(())
}

/// Execute one lens against the (live) output tree and merge its result
/// back.
fn run_lens(
    ctx: &Context,
    engine: &LensEngine<'_>,
    output: &mut MutableTree,
    lens: &LensConfig,
) -> Result<()> {
    // Build the glob-filtered input tree from the projection output,
    // re-rooted at input.root (pure tree work; composition glob semantics).
    let input_root_hash = match output.get_subtree(ctx, &lens.input_root)? {
        Some(subtree) => subtree.write(ctx)?,
        None => {
            return Err(Error::LensConfig {
                lens: lens.name.clone(),
                message: format!(
                    "could not resolve input.root \"{}\" within the projection output",
                    lens.input_root
                ),
            })
        }
    };
    let mut input_source = MutableTree::new(input_root_hash);
    let mut input_tree = MutableTree::empty();
    input_tree.merge(
        ctx,
        &mut input_source,
        &MergeOptions::new(Some(&lens.input_files), MergeMode::Overlay)?,
        ".",
    )?;
    let input_hash = input_tree.write(ctx)?;

    // Resolve the container identity and write the content-addressed spec.
    let container = match (&lens.container, lens.table.contains_key("package")) {
        (Some(c), _) => c.clone(),
        (None, true) => {
            return Err(Error::LensProtocol {
                container: format!("(habitat package lens '{}')", lens.name),
                message: "Habitat lens execution is retired; migrate the lens to an OCI \
                          image (specs/behaviors/lensing.md § Runtime decision)"
                    .into(),
            })
        }
        (None, false) => {
            return Err(Error::LensConfig {
                lens: lens.name.clone(),
                message: "hololens has no container defined".into(),
            })
        }
    };
    let identity = identity::resolve(engine.runtime, engine.registry, &container)?;
    let spec_table = spec::build_spec_table(lens, &identity.container, identity.local, input_hash);
    let spec_obj = spec::write_spec(ctx.repo, spec_table)?;
    let spec_hash = spec_obj.hash.to_string();

    // Spec-keyed cache: reads are trusted without re-execution
    // (content-addressing is the integrity model).
    let mut result_tree = None;
    if !engine.refresh {
        result_tree = read_cached_tree(ctx.repo, &spec_obj.cache_ref)?;
        if result_tree.is_some() {
            eprintln!("found existing output tree matching holospec({spec_hash})");
        }
    }

    let result_tree = match result_tree {
        Some(tree) => tree,
        None => {
            let tree = job::execute(
                ctx.repo,
                engine.runtime,
                &job::JobSpec {
                    spec_hash: &spec_hash,
                    container: &identity.container,
                    resolved_local: identity.local,
                    input_tree: input_hash,
                    timeout: Duration::from_secs(lens.timeout_secs),
                },
            )?;
            if engine.save {
                holo_tree::repo::update_ref(ctx.repo, &spec_obj.cache_ref, tree, None)?;
            }
            tree
        }
    };

    // Merge the result tree back at output.root with the declared mode.
    let target = output.get_or_create_subtree(ctx, &lens.output_root)?;
    let mut lensed = MutableTree::new(result_tree);
    target.merge(
        ctx,
        &mut lensed,
        &MergeOptions::new(None, lens.output_merge)?,
        ".",
    )?;

    Ok(())
}

// ── Cache ──────────────────────────────────────────────────────────────────

/// Read a spec-keyed cache ref, peeling to a tree (`git rev-parse
/// <ref>^{tree}` semantics): the ref may point at a tree directly
/// (both engines' native form) or at a commit.
pub fn read_cached_tree(repo: &gix::Repository, cache_ref: &str) -> Result<Option<ObjectId>> {
    let Some(id) = holo_tree::repo::resolve_ref(repo, cache_ref)? else {
        return Ok(None);
    };
    let obj = repo
        .find_object(id)
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?;
    match obj.kind {
        gix::object::Kind::Tree => Ok(Some(id)),
        gix::object::Kind::Commit => {
            let commit = obj
                .try_into_commit()
                .map_err(|_| holo_tree::Error::Git(format!("{id} failed to parse as commit")))?;
            Ok(Some(
                commit
                    .tree_id()
                    .map_err(|e| holo_tree::Error::Git(e.to_string()))?
                    .detach(),
            ))
        }
        _ => Ok(None),
    }
}

// ── Discovery ──────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct HololensFile {
    hololens: Option<toml::Table>,
}

/// Discover lens configs under `dir_path` (direct `*.toml` blob children),
/// resolve each one's sibling data tree, normalize, and order the set by its
/// `before`/`after` constraints (`Workspace.getLenses` / `Branch.getLenses`).
fn discover_lenses(
    ctx: &Context,
    tree: &mut MutableTree,
    dir_path: &str,
) -> Result<Vec<LensConfig>> {
    let Some(dir) = tree.get_subtree(ctx, dir_path)? else {
        return Ok(vec![]);
    };
    dir.ensure_children(ctx)?;

    // Snapshot config blobs in tree (byte-sorted) order.
    let mut entries: Vec<(String, ObjectId)> = Vec::new();
    for (name, child) in dir.children.iter().flatten() {
        let Some(stem) = name.strip_suffix(".toml") else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        if let Child::Blob { hash, .. } = child {
            entries.push((stem.to_string(), *hash));
        }
    }

    let mut lenses = Vec::with_capacity(entries.len());
    for (name, blob) in entries {
        let config_path = format!("{dir_path}/{name}.toml");
        let obj = ctx
            .repo
            .find_object(blob)
            .map_err(|e| holo_tree::Error::Git(e.to_string()))?;
        let text = std::str::from_utf8(&obj.data).map_err(|_| Error::Config {
            path: config_path.clone(),
            message: "non-UTF8".into(),
        })?;
        let parsed: HololensFile = toml::from_str(text).map_err(|e| Error::Config {
            path: config_path.clone(),
            message: e.to_string(),
        })?;
        let Some(table) = parsed.hololens else {
            return Err(Error::Config {
                path: config_path,
                message: "hololens config not found".into(),
            });
        };

        // Sibling data tree: `.holo/…/<name>/` alongside `<name>.toml`.
        let data_tree = match tree.get_subtree(ctx, &format!("{dir_path}/{name}"))? {
            Some(data) => Some(data.write(ctx)?),
            None => None,
        };

        lenses.push(LensConfig::normalize(&name, table, data_tree)?);
    }

    order_lenses(lenses)
}

/// Order lenses by `before`/`after` constraints (with `"*"` wildcards) using
/// the oracle's toposort.
fn order_lenses(lenses: Vec<LensConfig>) -> Result<Vec<LensConfig>> {
    if lenses.is_empty() {
        return Ok(lenses);
    }

    let names: Vec<String> = lenses.iter().map(|l| l.name.clone()).collect();
    let mut edges: Vec<(String, String)> = Vec::new();

    for lens in &lenses {
        let mut expand = |list: &[String], reverse: bool| -> Result<()> {
            let mut list = list.to_vec();
            let mut i = 0;
            while i < list.len() {
                let entry = list[i].clone();
                if entry == "*" {
                    for other in &names {
                        if other != &lens.name && !list.contains(other) {
                            list.push(other.clone());
                        }
                    }
                    i += 1;
                    continue;
                }
                if !names.contains(&entry) {
                    return Err(Error::Config {
                        path: lens.name.clone(),
                        message: format!(
                            "lens defines {}=\"{entry}\", but it was not found in [{}]",
                            if reverse { "before" } else { "after" },
                            names.join(",")
                        ),
                    });
                }
                if reverse {
                    edges.push((lens.name.clone(), entry));
                } else {
                    edges.push((entry, lens.name.clone()));
                }
                i += 1;
            }
            Ok(())
        };

        expand(&lens.after, false)?;
        expand(&lens.before, true)?;
    }

    let order = toposort::toposort(&names, &edges)?;

    let mut by_name: std::collections::BTreeMap<String, LensConfig> = lenses
        .into_iter()
        .map(|l| (l.name.clone(), l))
        .collect();
    Ok(order
        .into_iter()
        .filter_map(|name| by_name.remove(&name))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lens(name: &str, before: &[&str], after: &[&str]) -> LensConfig {
        let mut toml_text = format!("container = \"c/{name}:latest\"\n");
        if !before.is_empty() {
            toml_text.push_str(&format!(
                "before = [{}]\n",
                before
                    .iter()
                    .map(|b| format!("\"{b}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !after.is_empty() {
            toml_text.push_str(&format!(
                "after = [{}]\n",
                after
                    .iter()
                    .map(|a| format!("\"{a}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        LensConfig::normalize(name, toml_text.parse().unwrap(), None).unwrap()
    }

    #[test]
    fn order_unconstrained_keeps_discovery_order() {
        let out = order_lenses(vec![lens("b", &[], &[]), lens("a", &[], &[])]).unwrap();
        let names: Vec<&str> = out.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["b", "a"]);
    }

    #[test]
    fn order_respects_before_after() {
        let out = order_lenses(vec![
            lens("compile", &[], &["assets"]),
            lens("assets", &[], &[]),
        ])
        .unwrap();
        let names: Vec<&str> = out.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["assets", "compile"]);
    }

    #[test]
    fn order_wildcard_after_runs_last() {
        let out = order_lenses(vec![
            lens("zip", &[], &["*"]),
            lens("a", &[], &[]),
            lens("b", &[], &[]),
        ])
        .unwrap();
        let names: Vec<&str> = out.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "zip"]);
    }

    #[test]
    fn order_unknown_reference_errors() {
        let err = order_lenses(vec![lens("a", &[], &["missing"])]).unwrap_err();
        assert_eq!(err.code(), "CONFIG");
    }
}
