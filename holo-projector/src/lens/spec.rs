//! Lens config normalization and content-addressed spec objects
//! (`specs/behaviors/lensing.md` § Spec and content addressing — ported
//! behavior; conformance is byte/hash identity with `lib/Lens.js` +
//! `lib/SpecObject.js`).

use gix::ObjectId;
use toml::Value;

use super::iarna;
use crate::error::{Error, Result};
use holo_tree::MergeMode;

/// Default job deadline in seconds (mirrors `lib/Lens.js`), applied when the
/// lens config declares no positive `timeout`.
pub const DEFAULT_JOB_TIMEOUT_SECS: u64 = 600;

/// A discovered lens: its identity within the projection plus the normalized
/// config table (the oracle's `Lens.getConfig()` output).
#[derive(Debug, Clone)]
pub struct LensConfig {
    /// Lens name (config file basename).
    pub name: String,
    /// The normalized `[hololens]` table. Arbitrary author keys are
    /// preserved — everything here except `output`/`before`/`after`/`timeout`
    /// enters the spec.
    pub table: toml::Table,
    pub input_root: String,
    pub input_files: Vec<String>,
    pub output_root: String,
    pub output_merge: MergeMode,
    pub before: Vec<String>,
    pub after: Vec<String>,
    /// Job deadline (config `timeout`, engine default otherwise). Never part
    /// of the spec — a deadline cannot change output.
    pub timeout_secs: u64,
    /// The configured container reference (pre-resolution).
    pub container: Option<String>,
}

fn config_error(name: &str, message: impl Into<String>) -> Error {
    Error::LensConfig {
        lens: name.to_string(),
        message: message.into(),
    }
}

fn string_or_vec(name: &str, key: &str, value: &Value) -> Result<Vec<String>> {
    match value {
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Array(arr) => arr
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| config_error(name, format!("{key} entries must be strings")))
            })
            .collect(),
        _ => Err(config_error(
            name,
            format!("{key} must be a string or array of strings"),
        )),
    }
}

impl LensConfig {
    /// Normalize a raw `[hololens]` table exactly as `Lens.getConfig()` does:
    ///
    /// - `package` implies a default `command` (`lens-tree {{ input }}`) —
    ///   kept for spec byte-parity even though Habitat execution is retired;
    /// - `before`/`after` accept string or array;
    /// - `input.files` defaults to `["**"]` (string accepted), `input.root`
    ///   to `"."`;
    /// - `output.root` defaults to `input.root`, `output.merge` to
    ///   `"overlay"`;
    /// - `data` is set to the hash of the lens's sibling data tree when the
    ///   caller resolved one.
    pub fn normalize(
        name: &str,
        mut table: toml::Table,
        data_tree: Option<ObjectId>,
    ) -> Result<LensConfig> {
        if table.contains_key("package") && !table.contains_key("command") {
            table.insert(
                "command".to_string(),
                Value::String("lens-tree {{ input }}".to_string()),
            );
        }

        let before = match table.get("before") {
            Some(v) => string_or_vec(name, "before", v)?,
            None => vec![],
        };
        let after = match table.get("after") {
            Some(v) => string_or_vec(name, "after", v)?,
            None => vec![],
        };

        // input
        let mut input = match table.remove("input") {
            Some(Value::Table(t)) => t,
            Some(_) => return Err(config_error(name, "input must be a table")),
            None => toml::Table::new(),
        };
        let input_files = match input.get("files") {
            Some(v) => string_or_vec(name, "input.files", v)?,
            None => vec!["**".to_string()],
        };
        input.insert(
            "files".to_string(),
            Value::Array(input_files.iter().cloned().map(Value::String).collect()),
        );
        let input_root = match input.get("root") {
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(config_error(name, "input.root must be a string")),
            None => ".".to_string(),
        };
        input.insert("root".to_string(), Value::String(input_root.clone()));
        table.insert("input".to_string(), Value::Table(input));

        // output
        let mut output = match table.remove("output") {
            Some(Value::Table(t)) => t,
            Some(_) => return Err(config_error(name, "output must be a table")),
            None => toml::Table::new(),
        };
        let output_root = match output.get("root") {
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(config_error(name, "output.root must be a string")),
            None => input_root.clone(),
        };
        output.insert("root".to_string(), Value::String(output_root.clone()));
        let merge_str = match output.get("merge") {
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(config_error(name, "output.merge must be a string")),
            None => "overlay".to_string(),
        };
        output.insert("merge".to_string(), Value::String(merge_str.clone()));
        table.insert("output".to_string(), Value::Table(output));

        let output_merge = match merge_str.as_str() {
            "overlay" => MergeMode::Overlay,
            "underlay" => MergeMode::Underlay,
            "replace" => MergeMode::Replace,
            other => {
                return Err(config_error(
                    name,
                    format!("unknown output.merge mode: {other}"),
                ))
            }
        };

        if let Some(hash) = data_tree {
            table.insert("data".to_string(), Value::String(hash.to_string()));
        }

        let timeout_secs = match table.get("timeout") {
            Some(Value::Integer(t)) if *t > 0 => *t as u64,
            _ => DEFAULT_JOB_TIMEOUT_SECS,
        };

        let container = match table.get("container") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(config_error(name, "container must be a string")),
            None => None,
        };

        Ok(LensConfig {
            name: name.to_string(),
            table,
            input_root,
            input_files,
            output_root,
            output_merge,
            before,
            after,
            timeout_secs,
            container,
        })
    }
}

/// Mirror of the JS `deepSortKeys` quirk set that matters beyond key order
/// (order comes free from `toml::Table`'s BTreeMap): `Date` values degrade
/// to empty objects in the oracle, so datetimes become empty tables here.
fn deep_js_normalize(value: &mut Value) {
    match value {
        Value::Datetime(_) => *value = Value::Table(toml::Table::new()),
        Value::Array(arr) => arr.iter_mut().for_each(deep_js_normalize),
        Value::Table(t) => {
            for (_, v) in t.iter_mut() {
                deep_js_normalize(v);
            }
        }
        _ => {}
    }
}

/// A written, content-addressed lens spec.
#[derive(Debug, Clone)]
pub struct SpecObject {
    /// Blob hash of the serialized spec TOML — the key for all caching.
    pub hash: ObjectId,
    /// The serialized spec TOML bytes.
    pub toml: String,
    /// `refs/holo/lens/<xx>/<rest>` — where the cached result tree lives.
    pub cache_ref: String,
}

/// Assemble the spec data table for a container lens
/// (`Lens.buildSpecForContainer`): the normalized config with the resolved
/// container identity, the input tree hash, `_resolved = "local"` bookkeeping
/// when the identity was locally resolved (#417), and the non-output-bearing
/// keys (`output`, `before`, `after`, `timeout`) stripped.
pub fn build_spec_table(
    config: &LensConfig,
    container_identity: &str,
    resolved_local: bool,
    input_tree: ObjectId,
) -> toml::Table {
    let mut data = config.table.clone();
    data.remove("output");
    data.remove("before");
    data.remove("after");
    data.remove("timeout");
    data.insert(
        "container".to_string(),
        Value::String(container_identity.to_string()),
    );
    if resolved_local {
        data.insert(
            "_resolved".to_string(),
            Value::String("local".to_string()),
        );
    }
    data.insert(
        "input".to_string(),
        Value::String(input_tree.to_string()),
    );
    data
}

/// Serialize, hash, and store a lens spec (`SpecObject.write`): the blob is
/// written to the ODB and anchored at `refs/holo/spec/<hash>` so it can be
/// fetched and survives GC.
pub fn write_spec(repo: &gix::Repository, data: toml::Table) -> Result<SpecObject> {
    let mut lens_value = Value::Table(data);
    deep_js_normalize(&mut lens_value);

    let mut holospec = toml::Table::new();
    holospec.insert("lens".to_string(), lens_value);
    let mut doc = toml::Table::new();
    doc.insert("holospec".to_string(), Value::Table(holospec));

    let toml_text = iarna::stringify(&doc)?;

    let blob = repo
        .write_blob(toml_text.as_bytes())
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?
        .detach();

    let hash = blob.to_string();
    holo_tree::repo::update_ref(repo, &format!("refs/holo/spec/{hash}"), blob, None)?;

    Ok(SpecObject {
        hash: blob,
        toml: toml_text,
        cache_ref: cache_ref(&hash),
    })
}

/// `SpecObject.buildRef('lens', hash)`: the spec-keyed result cache ref.
pub fn cache_ref(spec_hash: &str) -> String {
    format!("refs/holo/lens/{}/{}", &spec_hash[..2], &spec_hash[2..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(toml_text: &str) -> toml::Table {
        let doc: toml::Table = toml_text.parse().unwrap();
        match doc.get("hololens") {
            Some(Value::Table(t)) => t.clone(),
            _ => panic!("no hololens table"),
        }
    }

    #[test]
    fn normalize_defaults() {
        let cfg = LensConfig::normalize(
            "mkdocs",
            parse("[hololens]\ncontainer = \"ghcr.io/hologit/lenses/mkdocs:latest\"\n"),
            None,
        )
        .unwrap();
        assert_eq!(cfg.input_files, ["**"]);
        assert_eq!(cfg.input_root, ".");
        assert_eq!(cfg.output_root, ".");
        assert_eq!(cfg.output_merge, MergeMode::Overlay);
        assert_eq!(cfg.timeout_secs, DEFAULT_JOB_TIMEOUT_SECS);
        assert_eq!(
            cfg.container.as_deref(),
            Some("ghcr.io/hologit/lenses/mkdocs:latest")
        );
    }

    #[test]
    fn normalize_string_files_and_merge() {
        let cfg = LensConfig::normalize(
            "x",
            parse(
                "[hololens]\ncontainer = \"c\"\n[hololens.input]\nfiles = \"*.js\"\nroot = \"sub\"\n[hololens.output]\nmerge = \"replace\"\n",
            ),
            None,
        )
        .unwrap();
        assert_eq!(cfg.input_files, ["*.js"]);
        assert_eq!(cfg.input_root, "sub");
        // output.root defaults to input.root
        assert_eq!(cfg.output_root, "sub");
        assert_eq!(cfg.output_merge, MergeMode::Replace);
    }

    #[test]
    fn spec_table_strips_and_injects() {
        let cfg = LensConfig::normalize(
            "x",
            parse(
                "[hololens]\ncontainer = \"ghcr.io/x:latest\"\nbefore = \"*\"\ntimeout = 30\n[hololens.output]\nmerge = \"replace\"\n",
            ),
            None,
        )
        .unwrap();
        let input_tree = ObjectId::empty_tree(gix::hash::Kind::Sha1);
        let data = build_spec_table(&cfg, "ghcr.io/x@sha256:abc", false, input_tree);
        assert!(!data.contains_key("output"));
        assert!(!data.contains_key("before"));
        assert!(!data.contains_key("timeout"));
        assert!(!data.contains_key("_resolved"));
        assert_eq!(
            data.get("container").and_then(Value::as_str),
            Some("ghcr.io/x@sha256:abc")
        );
        assert_eq!(
            data.get("input").and_then(Value::as_str),
            Some(input_tree.to_string().as_str())
        );

        let local = build_spec_table(&cfg, "sha256:deadbeef", true, input_tree);
        assert_eq!(
            local.get("_resolved").and_then(Value::as_str),
            Some("local")
        );
    }

    #[test]
    fn cache_ref_layout() {
        assert_eq!(
            cache_ref("0dc5566ea56b34afe9de7da93d6ae3de42876d8d"),
            "refs/holo/lens/0d/c5566ea56b34afe9de7da93d6ae3de42876d8d"
        );
    }

    #[test]
    fn package_implies_default_command() {
        let cfg =
            LensConfig::normalize("x", parse("[hololens]\npackage = \"holo/lens-x\"\n"), None)
                .unwrap();
        assert_eq!(
            cfg.table.get("command").and_then(Value::as_str),
            Some("lens-tree {{ input }}")
        );
    }
}
