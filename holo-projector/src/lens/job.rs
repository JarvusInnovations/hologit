//! One-shot v2 lens job execution (`specs/behaviors/lensing.md` § Job
//! protocol): push a wrapper commit (`.holospec/lens.toml` + `input/`) to the
//! container as a bundle on stdin, read back a bundle carrying
//! `refs/jobs/<spec-hash>/output` (success — first parent must be the input
//! commit) or `refs/jobs/<spec-hash>/error` (failure — a parentless commit
//! whose tree carries `exit-code`, `phase`, `log`, and optionally `command`).
//!
//! Bundle packing/unpacking shells out to the `git` CLI (`bundle create` /
//! `fetch`), matching the JS engine; fetch ingest hash-verifies every object,
//! which is the integrity model for results coming back across the container
//! boundary.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use gix::ObjectId;

use super::runtime::ContainerRuntime;
use crate::error::{Error, Result};

/// Parameters for executing a written container-lens spec.
pub struct JobSpec<'a> {
    /// The spec blob hash (the job key).
    pub spec_hash: &'a str,
    /// Resolved container identity from the spec (`container` key).
    pub container: &'a str,
    /// Whether the identity is locally resolved (`_resolved = "local"`, #417).
    pub resolved_local: bool,
    /// The input tree hash from the spec.
    pub input_tree: ObjectId,
    /// Job deadline (config `timeout` / engine default) — never in the spec.
    pub timeout: Duration,
}

/// Execute a container lens spec over the one-shot v2 transport and return
/// the output **tree** hash.
pub fn execute(
    repo: &gix::Repository,
    runtime: &dyn ContainerRuntime,
    job: &JobSpec<'_>,
) -> Result<ObjectId> {
    ensure_image(runtime, job)?;
    ensure_v2_protocol(runtime, job.container)?;

    let spec_hash = job.spec_hash;
    let input_ref = format!("refs/jobs/{spec_hash}/input");
    let output_ref = format!("refs/jobs/{spec_hash}/output");
    let error_ref = format!("refs/jobs/{spec_hash}/error");

    // Build the job input wrapper commit: .holospec/lens.toml + input/
    let spec_blob = ObjectId::from_hex(spec_hash.as_bytes())
        .map_err(|e| Error::Other(format!("invalid spec hash {spec_hash}: {e}")))?;
    let holospec_tree = write_tree(
        repo,
        &[TreeEntry {
            name: "lens.toml",
            id: spec_blob,
            kind: gix::objs::tree::EntryKind::Blob,
        }],
    )?;
    let wrapper_tree = write_tree(
        repo,
        &[
            TreeEntry {
                name: ".holospec",
                id: holospec_tree,
                kind: gix::objs::tree::EntryKind::Tree,
            },
            TreeEntry {
                name: "input",
                id: job.input_tree,
                kind: gix::objs::tree::EntryKind::Tree,
            },
        ],
    )?;
    let input_commit = holo_tree::repo::commit_tree(
        repo,
        wrapper_tree,
        &[],
        &format!("lens job {spec_hash}"),
        None,
        None,
    )?;
    holo_tree::repo::update_ref(repo, &input_ref, input_commit, None)?;

    let scratch = ScratchDir::create(spec_hash)?;

    let result = run_exchange(
        repo,
        runtime,
        job,
        &scratch,
        &input_ref,
        &output_ref,
        &error_ref,
        input_commit,
    );

    // Input objects stay reachable via the output commit's parent link, so
    // the input ref is transient.
    if let Err(err) = delete_ref(repo, &input_ref) {
        eprintln!("warning: failed to clean up {input_ref}: {err}");
    }

    result
}

#[allow(clippy::too_many_arguments)]
fn run_exchange(
    repo: &gix::Repository,
    runtime: &dyn ContainerRuntime,
    job: &JobSpec<'_>,
    scratch: &ScratchDir,
    input_ref: &str,
    output_ref: &str,
    error_ref: &str,
    input_commit: ObjectId,
) -> Result<ObjectId> {
    let spec_hash = job.spec_hash;

    // Bundle the input wrapper commit.
    let input_bundle_path = scratch.path().join("input.bundle");
    git(
        repo,
        &[
            "bundle",
            "create",
            "--quiet",
            path_str(&input_bundle_path)?,
            input_ref,
        ],
    )
    .map_err(|e| Error::Other(format!("failed to bundle lens job input: {e}")))?;
    let input_bundle = std::fs::read(&input_bundle_path)
        .map_err(|e| Error::Other(format!("failed to read input bundle: {e}")))?;

    // One-shot exchange: bundle on stdin, bundle on stdout, exit code
    // mirroring success/error; stderr is relayed by the runtime.
    eprintln!(
        "executing lens job {spec_hash} (deadline {}s)",
        job.timeout.as_secs()
    );
    let outcome = runtime.run_one_shot(job.container, spec_hash, &input_bundle, job.timeout)?;

    if outcome.timed_out {
        return Err(Error::LensTimeout {
            spec_hash: spec_hash.to_string(),
            timeout_secs: job.timeout.as_secs(),
        });
    }

    let transport_err = |message: String| Error::LensTransport {
        spec_hash: spec_hash.to_string(),
        message,
    };

    if outcome.stdout.is_empty() {
        let mut message = format!(
            "lens container exited with code {:?} without returning a bundle",
            outcome.exit_code
        );
        if !outcome.stderr_tail.is_empty() {
            message.push_str(&format!(":\n{}", outcome.stderr_tail.trim_end()));
        }
        return Err(transport_err(message));
    }

    // Persist the returned bundle and ingest via fetch, which hash-verifies
    // all objects.
    let result_bundle_path = scratch.path().join("result.bundle");
    std::fs::write(&result_bundle_path, &outcome.stdout)
        .map_err(|e| Error::Other(format!("failed to write result bundle: {e}")))?;

    if outcome.exit_code == Some(0) {
        git(
            repo,
            &[
                "fetch",
                path_str(&result_bundle_path)?,
                &format!("+{output_ref}:{output_ref}"),
            ],
        )
        .map_err(|e| transport_err(format!("failed to ingest result bundle: {e}")))?;

        let output_commit = holo_tree::repo::resolve_ref(repo, output_ref)?
            .ok_or_else(|| transport_err("result bundle did not deliver the output ref".into()))?;
        let commit = repo
            .find_object(output_commit)
            .map_err(|e| transport_err(format!("output commit unreadable: {e}")))?
            .try_into_commit()
            .map_err(|_| transport_err("output ref does not point at a commit".into()))?;

        // Integrity check (ported): the output commit's first parent must be
        // our input commit.
        let first_parent = commit.parent_ids().next().map(|id| id.detach());
        if first_parent != Some(input_commit) {
            return Err(transport_err(format!(
                "output commit parent {first_parent:?} does not match input commit {input_commit}"
            )));
        }

        let tree = commit
            .tree_id()
            .map_err(|e| transport_err(format!("output commit has no tree: {e}")))?
            .detach();
        return Ok(tree);
    }

    // Non-zero exit: expect a structured error bundle.
    let code = outcome.exit_code;
    git(
        repo,
        &[
            "fetch",
            path_str(&result_bundle_path)?,
            &format!("+{error_ref}:{error_ref}"),
        ],
    )
    .map_err(|e| {
        transport_err(format!(
            "lens container exited with code {code:?} without returning a readable error bundle: {e}"
        ))
    })?;

    let error_commit = holo_tree::repo::resolve_ref(repo, error_ref)?
        .ok_or_else(|| transport_err("error bundle did not deliver the error ref".into()))?;
    let error_tree = repo
        .find_object(error_commit)
        .map_err(|e| transport_err(format!("error commit unreadable: {e}")))?
        .try_into_commit()
        .map_err(|_| transport_err("error ref does not point at a commit".into()))?
        .tree_id()
        .map_err(|e| transport_err(format!("error commit has no tree: {e}")))?
        .detach();

    let read = |name: &str| read_tree_blob(repo, error_tree, name);
    let exit_code = read("exit-code")?
        .and_then(|s| s.trim().parse::<i32>().ok())
        .or(code)
        .unwrap_or(-1);
    let phase = read("phase")?.map(|s| s.trim().to_string());
    let log = read("log")?;
    let command = read("command")?.map(|s| s.trim().to_string());

    Err(Error::LensFailed {
        spec_hash: spec_hash.to_string(),
        exit_code,
        phase,
        log,
        command,
    })
}

// ── Image availability & protocol ──────────────────────────────────────────

fn ensure_image(runtime: &dyn ContainerRuntime, job: &JobSpec<'_>) -> Result<()> {
    if job.resolved_local {
        // Locally-resolved image (#417): identified by image ID, cannot be
        // pulled.
        if runtime.inspect_local(job.container)?.is_none() {
            return Err(Error::LensIdentity {
                container: job.container.to_string(),
                message: "locally-resolved lens image is not available in the local engine; \
                          rebuild the image or update the lens container config"
                    .into(),
            });
        }
        return Ok(());
    }

    if !is_digest_reference(job.container) {
        return Err(Error::LensIdentity {
            container: job.container.to_string(),
            message: "invalid container format (expected name@sha256:… digest reference)".into(),
        });
    }

    if runtime.inspect_local(job.container)?.is_none() {
        // Pull by digest — guarantees the exact image version matching the
        // spec that was used for caching.
        runtime.pull(job.container)?;
    }
    Ok(())
}

fn ensure_v2_protocol(runtime: &dyn ContainerRuntime, container: &str) -> Result<()> {
    match runtime.protocol_label(container)? {
        Some(v) if v == "2" => Ok(()),
        other => Err(Error::LensProtocol {
            container: container.to_string(),
            message: format!(
                "image advertises lens protocol {other:?}; this engine only speaks the v2 \
                 exec/stdio job protocol (v1 images run via the JS engine until migrated — \
                 hologit/lenses#32)"
            ),
        }),
    }
}

/// `name@sha256:<64 hex>` — the digest-pinned reference form.
pub fn is_digest_reference(reference: &str) -> bool {
    let Some(idx) = reference.rfind("@sha256:") else {
        return false;
    };
    if idx == 0 {
        return false;
    }
    let hex = &reference[idx + "@sha256:".len()..];
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// ── Git plumbing helpers ───────────────────────────────────────────────────

fn git(repo: &gix::Repository, args: &[&str]) -> std::result::Result<(), String> {
    let git_dir = repo.path();
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(git_dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to spawn git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed ({}): {}",
            args.first().unwrap_or(&""),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

struct TreeEntry<'a> {
    name: &'a str,
    id: ObjectId,
    kind: gix::objs::tree::EntryKind,
}

/// Write a tree object from pre-sorted entries.
fn write_tree(repo: &gix::Repository, entries: &[TreeEntry<'_>]) -> Result<ObjectId> {
    let tree = gix::objs::Tree {
        entries: entries
            .iter()
            .map(|e| gix::objs::tree::Entry {
                mode: e.kind.into(),
                filename: e.name.into(),
                oid: e.id,
            })
            .collect(),
    };
    Ok(repo
        .write_object(&tree)
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?
        .detach())
}

fn read_tree_blob(
    repo: &gix::Repository,
    tree_id: ObjectId,
    name: &str,
) -> Result<Option<String>> {
    let tree = repo
        .find_object(tree_id)
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?
        .try_into_tree()
        .map_err(|_| holo_tree::Error::Git(format!("{tree_id} is not a tree")))?;
    let Some(entry) = tree
        .lookup_entry_by_path(name)
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?
    else {
        return Ok(None);
    };
    let blob = repo
        .find_object(entry.oid().to_owned())
        .map_err(|e| holo_tree::Error::Git(e.to_string()))?;
    if blob.kind != gix::object::Kind::Blob {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&blob.data).into_owned()))
}

fn delete_ref(repo: &gix::Repository, refname: &str) -> Result<()> {
    use gix::refs::transaction::{Change, PreviousValue, RefEdit, RefLog};

    let name: gix::refs::FullName = refname
        .try_into()
        .map_err(|e: gix::refs::name::Error| holo_tree::Error::Git(e.to_string()))?;
    repo.edit_reference(RefEdit {
        change: Change::Delete {
            expected: PreviousValue::Any,
            log: RefLog::AndReference,
        },
        name,
        deref: false,
    })
    .map_err(|e| holo_tree::Error::Git(e.to_string()))?;
    Ok(())
}

// ── Scratch dir ────────────────────────────────────────────────────────────

/// A per-job private scratch directory, removed on drop.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn create(spec_hash: &str) -> Result<Self> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "holo-lens-job-{}-{:x}-{:x}",
            &spec_hash[..12.min(spec_hash.len())],
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&path)
            .map_err(|e| Error::Other(format!("failed to create scratch dir: {e}")))?;
        Ok(ScratchDir { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn path_str(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| Error::Other("scratch path is not valid UTF-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_reference_detection() {
        assert!(is_digest_reference(
            "ghcr.io/hologit/lenses/mkdocs@sha256:6b6b0bdb5beb2b3f852cc1cdfb7d2a67fc036bce7f26ac63efc39e8e2a2a4738"
        ));
        assert!(!is_digest_reference("ghcr.io/hologit/lenses/mkdocs:v2"));
        assert!(!is_digest_reference("@sha256:6b6b0bdb5beb2b3f852cc1cdfb7d2a67fc036bce7f26ac63efc39e8e2a2a4738"));
        assert!(!is_digest_reference("x@sha256:short"));
        // uppercase hex is not the canonical form
        assert!(!is_digest_reference(&format!("x@sha256:{}", "A".repeat(64))));
    }
}
