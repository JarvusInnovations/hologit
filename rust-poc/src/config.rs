//! TOML configuration types matching hologit's `.holo/` structure.
//!
//! Reads config directly from git tree objects (blobs) via gix — no working
//! tree or filesystem access needed.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;

use crate::tree::MutableTree;

// ── Workspace config (.holo/config.toml) ───────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WorkspaceConfigFile {
    pub holospace: WorkspaceConfig,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceConfig {
    pub name: Option<String>,
}

// ── Branch config (.holo/branches/{name}.toml) ─────────────────────────────

#[derive(Debug, Deserialize, Default)]
pub struct BranchConfigFile {
    #[serde(default)]
    pub holobranch: BranchConfig,
}

#[derive(Debug, Deserialize, Default)]
pub struct BranchConfig {
    pub extend: Option<String>,
    pub lens: Option<bool>,
}

// ── Mapping config (.holo/branches/{name}/{key}.toml) ──────────────────────

#[derive(Debug, Deserialize)]
pub struct MappingConfigFile {
    pub holomapping: RawMappingConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RawMappingConfig {
    pub holosource: Option<String>,
    pub files: Option<StringOrVec>,
    pub root: Option<String>,
    pub output: Option<String>,
    pub layer: Option<String>,
    pub before: Option<StringOrVec>,
    pub after: Option<StringOrVec>,
}

/// Resolved mapping with defaults applied (mirrors Mapping.getConfig() logic)
#[derive(Debug, Clone)]
pub struct MappingConfig {
    pub key: String,
    pub holosource: String,
    pub files: Vec<String>,
    pub root: String,
    pub output: String,
    pub layer: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

impl MappingConfig {
    /// Apply the same defaulting logic as Mapping.js getConfig()
    pub fn from_raw(key: &str, raw: &RawMappingConfig) -> Result<Self> {
        let basename = key.rsplit('/').next().unwrap_or(key);
        let local_name = basename.strip_prefix('_').unwrap_or(basename);

        let holosource = match &raw.holosource {
            Some(s) if s.starts_with("=>") => format!("{local_name}{s}"),
            Some(s) => s.clone(),
            None => local_name.to_string(),
        };

        let files = match &raw.files {
            Some(f) => f.to_vec(),
            None => bail!("holomapping has no files defined: {key}"),
        };

        let root = normalize_path(raw.root.as_deref().unwrap_or("."));

        // Output path: dirname(key) / (basename starts with _ ? "." : basename) / config.output
        let key_dir = key.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
        let output_base = if basename.starts_with('_') { "." } else { basename };
        let raw_output = raw.output.as_deref().unwrap_or(".");
        let output = if key_dir == "." {
            normalize_path(&format!("{output_base}/{raw_output}"))
        } else {
            normalize_path(&format!("{key_dir}/{output_base}/{raw_output}"))
        };

        let layer = raw
            .layer
            .clone()
            .unwrap_or_else(|| holosource.clone());

        Ok(MappingConfig {
            key: key.to_string(),
            holosource,
            files,
            root,
            output,
            layer,
            before: raw.before.as_ref().map(|s| s.to_vec()).unwrap_or_default(),
            after: raw.after.as_ref().map(|s| s.to_vec()).unwrap_or_default(),
        })
    }
}

// ── Source config (.holo/sources/{name}.toml) ──────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SourceConfigFile {
    pub holosource: SourceConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SourceConfig {
    pub url: Option<String>,
    pub r#ref: Option<String>,
    pub project: Option<SourceProjectConfig>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SourceProjectConfig {
    pub holobranch: String,
    pub lens: Option<bool>,
}

// ── Helper: TOML string-or-array ───────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum StringOrVec {
    Single(String),
    Multiple(Vec<String>),
}

impl StringOrVec {
    pub fn to_vec(&self) -> Vec<String> {
        match self {
            StringOrVec::Single(s) => vec![s.clone()],
            StringOrVec::Multiple(v) => v.clone(),
        }
    }
}

// ── Config reading from git tree ───────────────────────────────────────────

/// Read and parse a TOML config file from a git tree
pub fn read_toml<T: serde::de::DeserializeOwned>(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    path: &str,
) -> Result<Option<T>> {
    let blob = tree.read_blob(repo, path)?;

    match blob {
        None => Ok(None),
        Some(data) => {
            let text = std::str::from_utf8(&data)
                .with_context(|| format!("non-UTF8 content in {path}"))?;
            let parsed: T =
                toml::from_str(text).with_context(|| format!("failed to parse {path}"))?;
            Ok(Some(parsed))
        }
    }
}

/// Discover all mappings for a holobranch by walking .holo/branches/{name}/
/// Returns mapping configs in discovery order (caller must toposort).
pub fn discover_mappings(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    branch_name: &str,
) -> Result<Vec<MappingConfig>> {
    let branch_tree_path = format!(".holo/branches/{branch_name}");

    let branch_tree = tree.get_subtree(repo, &branch_tree_path)?;
    let branch_tree = match branch_tree {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    let mut mappings = Vec::new();
    walk_mapping_tree(repo, branch_tree, "", &mut mappings)?;
    Ok(mappings)
}

/// Recursively walk a mapping tree directory, collecting MappingConfigs
fn walk_mapping_tree(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    prefix: &str,
    out: &mut Vec<MappingConfig>,
) -> Result<()> {
    tree.ensure_children(repo)?;

    tree.ensure_children(repo)?;

    // Collect names and types first to avoid borrow issues
    let entries: Vec<(String, bool, Option<gix::ObjectId>)> = tree
        .children
        .as_ref()
        .unwrap()
        .iter()
        .map(|(name, child)| {
            let is_tree = matches!(child, crate::tree::Child::Tree(_));
            let hash = match child {
                crate::tree::Child::Blob { hash, .. } => Some(*hash),
                _ => None,
            };
            (name.clone(), is_tree, hash)
        })
        .collect();

    for (name, is_tree, blob_hash) in entries {
        if is_tree {
            let new_prefix = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let subtree = tree.get_subtree(repo, &name)?.unwrap();
            walk_mapping_tree(repo, subtree, &new_prefix, out)?;
            continue;
        }

        // Match .toml files
        let toml_name = match name.strip_suffix(".toml") {
            Some(n) => n,
            None => continue,
        };

        // Read and parse the mapping config blob
        let hash = blob_hash.unwrap();
        let obj = repo.find_object(hash)?;
        let text = std::str::from_utf8(&obj.data)
            .with_context(|| format!("non-UTF8 in mapping {name}"))?;
        let parsed: MappingConfigFile =
            toml::from_str(text).with_context(|| format!("failed to parse mapping {name}"))?;

        let key = if prefix.is_empty() {
            toml_name.to_string()
        } else {
            format!("{prefix}/{toml_name}")
        };

        out.push(MappingConfig::from_raw(&key, &parsed.holomapping)?);
    }

    Ok(())
}

/// Resolve a source's head commit hash from a gitlink entry in the workspace tree.
/// This reads `.holo/sources/{name}` — if it's a commit (gitlink), returns its hash.
pub fn resolve_gitlink(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    source_name: &str,
) -> Result<Option<gix::ObjectId>> {
    tree.ensure_children(repo)?;

    // Navigate to .holo/sources
    let sources_tree = match tree.get_subtree(repo, ".holo/sources")? {
        Some(t) => t,
        None => return Ok(None),
    };

    sources_tree.ensure_children(repo)?;
    let children = match &sources_tree.children {
        Some(c) => c,
        None => return Ok(None),
    };

    match children.get(source_name) {
        Some(crate::tree::Child::Commit { hash }) => Ok(Some(*hash)),
        _ => {
            // Also check for name without => suffix
            let base_name = source_name.split("=>").next().unwrap_or(source_name);
            if base_name != source_name {
                match children.get(base_name) {
                    Some(crate::tree::Child::Commit { hash }) => Ok(Some(*hash)),
                    _ => Ok(None),
                }
            } else {
                Ok(None)
            }
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Normalize a path (collapse . and redundant separators), equivalent to
/// path.join('.', x, '.') in the JS code
fn normalize_path(p: &str) -> String {
    let parts: Vec<&str> = p
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();

    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

