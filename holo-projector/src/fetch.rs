//! Remote source fetching: the edge capability that populates the
//! `refs/holo/source/...` cache namespace (`specs/behaviors/source-resolution.md`).
//!
//! Resolution ([`crate::source::resolve`]) is pure — it only reads refs and
//! objects already present. When a caller wants unfetched sources resolved,
//! it supplies a [`SourceFetcher`] (via the `*_fetching` entry points), and
//! resolution falls back to a fetch-and-retry exactly where the legacy JS
//! engine does (`lib/Source.js` `getHead`).
//!
//! The shipped implementation, [`GitCliFetcher`], shells out to `git fetch`.
//! This is the spec's **declared interim transport**: byte-identical observable
//! behavior to the JS engine (`--depth=1 --no-tags`, forced refspec, auto-gc
//! disabled per #450) and full credential-helper/ssh auth support, at zero new
//! crate dependencies. gix-native fetch is the desired end state — see the
//! Status table in `specs/behaviors/source-resolution.md` for the empirical
//! probe results that drove this choice.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::{Error, Result};
use crate::source;

/// How much history a fetch should transfer. Never changes what the cached
/// ref points at — depth is a transfer optimization only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchKind {
    /// Shallow single-ref fetch at depth 1 (the default source fetch).
    Shallow,
    /// History-completing fetch used for gitlink recovery: unshallows the
    /// repository when it is shallow, plain full fetch otherwise.
    Unshallow,
}

/// The fetch capability threaded into source resolution by the
/// `*_fetching` entry points.
pub trait SourceFetcher {
    /// Fetch `git_ref` (a fully-qualified ref or a `refs/...*` pattern) from
    /// `url` into the holo source cache namespace, and return the
    /// destination ref (or pattern) written.
    fn fetch(&self, url: &str, git_ref: &str, kind: FetchKind) -> Result<String>;
}

/// [`SourceFetcher`] backed by the `git` CLI.
///
/// Serializes fetches per git dir process-wide: concurrent shallow fetches
/// sharing one `.git/shallow` otherwise abort (`fatal: shallow file has
/// changed since we read it` — issue #450; gix fails fast on `shallow.lock`
/// the same way). Serialization plus per-fetch `gc.auto=0` /
/// `maintenance.auto=false` is the specced mitigation.
pub struct GitCliFetcher {
    git_dir: PathBuf,
}

impl GitCliFetcher {
    /// Fetcher for the repository behind an open gix handle.
    pub fn new(repo: &gix::Repository) -> Self {
        Self {
            git_dir: repo.git_dir().to_path_buf(),
        }
    }

    /// Fetcher for an explicit git dir path.
    pub fn for_git_dir(git_dir: impl Into<PathBuf>) -> Self {
        Self {
            git_dir: git_dir.into(),
        }
    }

    /// Write the source's canonical spec TOML as a blob and pin it at
    /// `refs/holo/spec/{hash}` (GC protection; makes the spec fetchable),
    /// mirroring the JS engine's `SpecObject.write`.
    fn write_spec_blob(&self, url: &str) -> Result<()> {
        let (hash, toml) = source::compute_spec(url)?;

        let repo = gix::open(&self.git_dir)
            .map_err(|e| holo_tree::Error::Git(format!("failed to open repo for spec write: {e}")))?;
        let blob_id = repo
            .write_blob(toml.as_bytes())
            .map_err(|e| holo_tree::Error::Git(format!("failed to write spec blob: {e}")))?
            .detach();

        debug_assert_eq!(blob_id.to_string(), hash);

        use gix::refs::transaction::PreviousValue;
        repo.reference(
            format!("refs/holo/spec/{hash}"),
            blob_id,
            PreviousValue::Any,
            "holo: pin source spec",
        )
        .map_err(|e| holo_tree::Error::Git(format!("failed to pin spec ref: {e}")))?;

        Ok(())
    }
}

impl SourceFetcher for GitCliFetcher {
    fn fetch(&self, url: &str, git_ref: &str, kind: FetchKind) -> Result<String> {
        let suffix = match git_ref.strip_prefix("refs/") {
            Some(s) if !s.is_empty() => s,
            _ => {
                return Err(Error::SourceFetch {
                    url: url.to_string(),
                    reason: format!("ref '{git_ref}' must be fully qualified (refs/...)"),
                })
            }
        };

        let spec_hash = source::compute_spec_hash(url)?;
        let dest = format!(
            "refs/holo/source/{}/{}/{}",
            &spec_hash[..2],
            &spec_hash[2..],
            suffix
        );
        let refspec = format!("+{git_ref}:{dest}");

        // Serialize all fetches into this git dir (issue #450): git aborts a
        // concurrent shallow fetch when another writer touches .git/shallow.
        let lock = lock_for_git_dir(&self.git_dir);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        self.write_spec_blob(url)?;

        let mut cmd = Command::new("git");
        cmd.arg("--git-dir")
            .arg(&self.git_dir)
            // Keep git from spawning background maintenance that could
            // rewrite .git/shallow mid-fetch (issue #450).
            .args(["-c", "gc.auto=0", "-c", "maintenance.auto=false"])
            .args(["fetch", "--no-tags"]);

        match kind {
            FetchKind::Shallow => {
                cmd.args(["--depth", "1"]);
            }
            FetchKind::Unshallow => {
                // `--unshallow` is only valid on an actually-shallow repo.
                if self.git_dir.join("shallow").exists() {
                    cmd.arg("--unshallow");
                }
            }
        }

        cmd.arg(url).arg(&refspec);

        let output = cmd.output().map_err(|e| Error::SourceFetch {
            url: url.to_string(),
            reason: format!("failed to run git fetch: {e}"),
        })?;

        if !output.status.success() {
            return Err(Error::SourceFetch {
                url: url.to_string(),
                reason: format!(
                    "git fetch {refspec} exited with {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            });
        }

        Ok(dest)
    }
}

// ── Per-git-dir fetch serialization ─────────────────────────────────────────

static FETCH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn lock_for_git_dir(git_dir: &Path) -> Arc<Mutex<()>> {
    // Canonicalize so worktree/relative aliases of one git dir share a lock;
    // fall back to the given path when the dir can't be canonicalized.
    let key = git_dir
        .canonicalize()
        .unwrap_or_else(|_| git_dir.to_path_buf());

    let map = FETCH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
}
