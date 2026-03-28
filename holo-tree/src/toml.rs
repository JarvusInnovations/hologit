//! Generic TOML-from-git-blob reader.

use crate::error::{Error, Result};
use crate::tree::MutableTree;

/// Read and parse a TOML file from a blob inside a git tree.
/// Returns `None` if the blob doesn't exist at the given path.
pub fn read_toml<T: serde::de::DeserializeOwned>(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    path: &str,
) -> Result<Option<T>> {
    let blob = tree.read_blob(repo, path)?;
    match blob {
        None => Ok(None),
        Some(data) => {
            let text = std::str::from_utf8(&data).map_err(|_| Error::Toml {
                path: path.into(),
                message: "non-UTF8 content".into(),
            })?;
            let parsed: T = toml::from_str(text).map_err(|e| Error::Toml {
                path: path.into(),
                message: e.to_string(),
            })?;
            Ok(Some(parsed))
        }
    }
}
