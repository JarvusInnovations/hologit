//! TOML configuration types for `.holo/` files.
//!
//! Reads config directly from git tree blobs via gix — no working tree
//! or filesystem access needed.

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::tree::MutableTree;

// ── Workspace (.holo/config.toml) ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WorkspaceConfigFile {
    pub holospace: WorkspaceConfig,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceConfig {
    pub name: Option<String>,
}

// ── Branch (.holo/branches/{name}.toml) ────────────────────────────────────

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

// ── Mapping (.holo/branches/{branch}/{key}.toml) ───────────────────────────

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

/// Resolved mapping with all defaults applied.
/// Mirrors `Mapping.getConfig()` in the JS codebase.
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
    /// Build a resolved mapping from raw TOML and the mapping key.
    ///
    /// Applies the same defaulting rules as `Mapping.getConfig()`:
    /// - `holosource` defaults to basename (strip leading `_`)
    /// - `holosource` starting with `=>` gets local name prepended
    /// - `output` is computed from key dirname + basename + config.output
    /// - `layer` defaults to holosource
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
            None => {
                return Err(Error::Config {
                    path: format!("{key}.toml"),
                    message: "holomapping has no files defined".into(),
                })
            }
        };

        let root = normalize_path(raw.root.as_deref().unwrap_or("."));

        // Output = dirname(key) / (basename starts with _ ? "." : basename) / config.output
        let key_dir = key.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
        let output_base = if basename.starts_with('_') { "." } else { basename };
        let raw_output = raw.output.as_deref().unwrap_or(".");
        let output = if key_dir == "." {
            normalize_path(&format!("{output_base}/{raw_output}"))
        } else {
            normalize_path(&format!("{key_dir}/{output_base}/{raw_output}"))
        };

        let layer = raw.layer.clone().unwrap_or_else(|| holosource.clone());

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

// ── Source (.holo/sources/{name}.toml) ─────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SourceConfigFile {
    pub holosource: SourceConfig,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct SourceConfig {
    pub url: Option<String>,
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    pub project: Option<SourceProjectConfig>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SourceProjectConfig {
    pub holobranch: String,
    pub lens: Option<bool>,
}

// ── String-or-array helper ─────────────────────────────────────────────────

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

// ── Config reading ─────────────────────────────────────────────────────────

/// Read and parse a TOML file from a blob inside a git tree.
pub fn read_toml<T: serde::de::DeserializeOwned>(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    path: &str,
) -> Result<Option<T>> {
    let blob = tree.read_blob(repo, path)?;
    match blob {
        None => Ok(None),
        Some(data) => {
            let text = std::str::from_utf8(&data).map_err(|_| Error::Config {
                path: path.into(),
                message: "non-UTF8 content".into(),
            })?;
            let parsed: T = toml::from_str(text).map_err(|e| Error::Config {
                path: path.into(),
                message: e.to_string(),
            })?;
            Ok(Some(parsed))
        }
    }
}

// ── Mapping discovery ──────────────────────────────────────────────────────

/// Walk `.holo/branches/{branch_name}/` and collect all mapping configs.
pub fn discover_mappings(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    branch_name: &str,
) -> Result<Vec<MappingConfig>> {
    let path = format!(".holo/branches/{branch_name}");
    let branch_tree = match tree.get_subtree(repo, &path)? {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    let mut out = Vec::new();
    walk_mappings(repo, branch_tree, "", &mut out)?;
    Ok(out)
}

/// Recursively walk a mapping tree directory.
fn walk_mappings(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    prefix: &str,
    out: &mut Vec<MappingConfig>,
) -> Result<()> {
    tree.ensure_children(repo)?;

    // Snapshot names + types to avoid borrow conflicts during recursion
    let entries: Vec<(String, bool, Option<gix::ObjectId>)> = tree
        .children
        .as_ref()
        .unwrap()
        .iter()
        .map(|(name, child)| {
            let is_tree = matches!(child, crate::tree::Child::Tree(_));
            let blob_hash = match child {
                crate::tree::Child::Blob { hash, .. } => Some(*hash),
                _ => None,
            };
            (name.clone(), is_tree, blob_hash)
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
            walk_mappings(repo, subtree, &new_prefix, out)?;
            continue;
        }

        let toml_name = match name.strip_suffix(".toml") {
            Some(n) => n,
            None => continue,
        };

        let hash = blob_hash.unwrap();
        let obj = repo.find_object(hash)?;
        let text = std::str::from_utf8(&obj.data).map_err(|_| Error::Config {
            path: name.clone(),
            message: "non-UTF8".into(),
        })?;
        let parsed: MappingConfigFile = toml::from_str(text).map_err(|e| Error::Config {
            path: name.clone(),
            message: e.to_string(),
        })?;

        let key = if prefix.is_empty() {
            toml_name.to_string()
        } else {
            format!("{prefix}/{toml_name}")
        };

        out.push(MappingConfig::from_raw(&key, &parsed.holomapping)?);
    }

    Ok(())
}

// ── Gitlink resolution ─────────────────────────────────────────────────────

/// Look for a gitlink (commit entry) at `.holo/sources/{name}` in the tree.
pub fn resolve_gitlink(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    source_name: &str,
) -> Result<Option<gix::ObjectId>> {
    let sources = match tree.get_subtree(repo, ".holo/sources")? {
        Some(t) => t,
        None => return Ok(None),
    };

    sources.ensure_children(repo)?;
    let children = match &sources.children {
        Some(c) => c,
        None => return Ok(None),
    };

    if let Some(crate::tree::Child::Commit { hash }) = children.get(source_name) {
        return Ok(Some(*hash));
    }

    // Also try base name (without =>holobranch suffix)
    let base = source_name.split("=>").next().unwrap_or(source_name);
    if base != source_name {
        if let Some(crate::tree::Child::Commit { hash }) = children.get(base) {
            return Ok(Some(*hash));
        }
    }

    Ok(None)
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Normalize a path: collapse `.` and empty segments.
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
