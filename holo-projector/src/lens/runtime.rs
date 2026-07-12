//! Container-runtime and registry seams for lens execution.
//!
//! The engine abstracts the container runtime behind the exec/stdio seam
//! (`specs/behaviors/lensing.md` § Runtime decision): Docker and Podman are
//! equally supported through their CLIs, nothing may depend on
//! Docker-specific behavior, and the trait boundary is where remoted lensing
//! (#79) and test harnesses plug in.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// OCI image label marking a lens image as implementing the v2 job protocol.
pub const PROTOCOL_LABEL: &str = "sh.holo.lens.protocol";

/// Container label applied to one-shot job containers so an engine crash
/// leaves them discoverable for cleanup (`docker ps -a --filter label=…`).
pub const JOB_LABEL: &str = "sh.holo.lens.job";

/// A locally-present image's identity, from the local engine's store.
#[derive(Debug, Clone)]
pub struct LocalImage {
    /// The engine-local image ID (`sha256:…`) — the identity of last resort
    /// for never-pushed images (#417).
    pub id: String,
    /// Repository digests (`name@sha256:…`) recorded when the image was
    /// pulled from or pushed to a registry.
    pub repo_digests: Vec<String>,
}

/// Outcome of a one-shot lens job container run.
#[derive(Debug)]
pub struct OneShotOutcome {
    /// The container process's exit code (`None` if terminated by signal).
    pub exit_code: Option<i32>,
    /// Raw stdout — the result bundle (binary-clean per the stdio
    /// discipline).
    pub stdout: Vec<u8>,
    /// Tail of stderr, for transport-error diagnostics.
    pub stderr_tail: String,
    /// The job exceeded its deadline and was cancelled.
    pub timed_out: bool,
}

/// The container-runtime seam: everything the lens executor needs from a
/// local (or remote — `DOCKER_HOST` etc. ride along transparently) OCI
/// runtime.
pub trait ContainerRuntime {
    /// Inspect a locally-present image; `Ok(None)` when not present.
    fn inspect_local(&self, reference: &str) -> Result<Option<LocalImage>>;

    /// Pull an image (by tag or digest reference).
    fn pull(&self, reference: &str) -> Result<()>;

    /// Read the image's `sh.holo.lens.protocol` label, if any.
    fn protocol_label(&self, reference: &str) -> Result<Option<String>>;

    /// Run a one-shot v2 lens job: the image's default entrypoint with no
    /// arguments, the input bundle on stdin, the result bundle on stdout,
    /// stderr relayed as logging. Enforces `deadline`; on expiry the
    /// container must be force-removed (no partial results are read).
    fn run_one_shot(
        &self,
        image: &str,
        spec_hash: &str,
        input_bundle: &[u8],
        deadline: Duration,
    ) -> Result<OneShotOutcome>;
}

/// The registry seam (identity-resolution rung 3): resolve a tag to its
/// manifest digest with a HEAD request over plain OCI registry HTTP — no
/// container-engine CLI dependency (`specs/behaviors/lensing.md`
/// § Container identity resolution).
pub trait RegistryClient {
    /// Return the manifest digest (`sha256:…`) the registry currently serves
    /// for `reference` (a tag reference). For multi-platform images this is
    /// the manifest-index digest — the Accept negotiation must prefer index
    /// media types.
    fn manifest_digest(&self, reference: &str) -> Result<String>;
}

// ── Container CLI implementation ───────────────────────────────────────────

/// `ContainerRuntime` over a container-engine CLI (`docker` or `podman`,
/// same argument surface for everything the engine uses).
#[derive(Debug, Clone)]
pub struct ContainerCli {
    program: String,
}

impl ContainerCli {
    pub fn new(program: impl Into<String>) -> Self {
        ContainerCli {
            program: program.into(),
        }
    }

    /// Autodetect an available container engine: `docker`, then `podman`.
    pub fn detect() -> Result<Self> {
        for program in ["docker", "podman"] {
            let found = Command::new(program)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if found {
                return Ok(ContainerCli::new(program));
            }
        }
        Err(Error::Other(
            "no container engine found (tried docker, podman); lens execution requires one"
                .into(),
        ))
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    fn run(&self, args: &[&str]) -> Result<std::process::Output> {
        Command::new(&self.program)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| Error::Other(format!("failed to spawn {}: {e}", self.program)))
    }

    /// Run an inspect returning trimmed stdout, or `None` on inspect failure
    /// (image not present).
    fn inspect_format(&self, reference: &str, format: &str) -> Result<Option<String>> {
        let output = self.run(&["image", "inspect", "--format", format, reference])?;
        if !output.status.success() {
            return Ok(None);
        }
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    }
}

impl ContainerRuntime for ContainerCli {
    fn inspect_local(&self, reference: &str) -> Result<Option<LocalImage>> {
        let Some(id) = self.inspect_format(reference, "{{.Id}}")? else {
            return Ok(None);
        };
        let digests = self
            .inspect_format(reference, "{{range .RepoDigests}}{{.}} {{end}}")?
            .unwrap_or_default();
        Ok(Some(LocalImage {
            id,
            repo_digests: digests
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        }))
    }

    fn pull(&self, reference: &str) -> Result<()> {
        eprintln!("pulling required image: {reference}");
        let status = Command::new(&self.program)
            .args(["pull", reference])
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| Error::Other(format!("failed to spawn {}: {e}", self.program)))?;
        if !status.success() {
            return Err(Error::LensIdentity {
                container: reference.to_string(),
                message: format!("failed to pull container image ({status})"),
            });
        }
        Ok(())
    }

    fn protocol_label(&self, reference: &str) -> Result<Option<String>> {
        let format = format!("{{{{index .Config.Labels \"{PROTOCOL_LABEL}\"}}}}");
        let label = self.inspect_format(reference, &format)?;
        Ok(label.filter(|v| !v.is_empty() && v != "<no value>"))
    }

    fn run_one_shot(
        &self,
        image: &str,
        spec_hash: &str,
        input_bundle: &[u8],
        deadline: Duration,
    ) -> Result<OneShotOutcome> {
        let nonce = {
            use std::time::{SystemTime, UNIX_EPOCH};
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            format!("{:08x}", nanos ^ std::process::id())
        };
        let container_name = format!("holo-lens-job-{}-{nonce}", &spec_hash[..12]);
        let job_label = format!("{JOB_LABEL}={spec_hash}");

        let mut child = Command::new(&self.program)
            .args([
                "run",
                "--rm",
                "--interactive",
                "--name",
                &container_name,
                "--label",
                &job_label,
                image,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::Other(format!("failed to spawn {}: {e}", self.program)))?;

        // Writer thread: stream the bundle in, ignoring EPIPE if the
        // container exits before consuming all input.
        let mut stdin = child.stdin.take().expect("stdin piped");
        let input = input_bundle.to_vec();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
            drop(stdin);
        });

        // Reader threads: stdout is the (binary) result bundle; stderr is
        // relayed line-by-line as dimmed logging.
        let mut stdout_pipe = child.stdout.take().expect("stdout piped");
        let stdout_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout_pipe.read_to_end(&mut buf);
            buf
        });
        let stderr_pipe = child.stderr.take().expect("stderr piped");
        let stderr_reader = std::thread::spawn(move || {
            use std::io::BufRead;
            let mut tail = String::new();
            let reader = std::io::BufReader::new(stderr_pipe);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                eprintln!("\x1b[90m{line}\x1b[0m");
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > 16384 {
                    tail = tail[tail.len() - 16384..].to_string();
                }
            }
            tail
        });

        // Deadline loop: poll the client process; on expiry force-remove the
        // container itself (killing the attached client alone can leave the
        // container running), then kill the client.
        let start = Instant::now();
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if start.elapsed() >= deadline {
                        timed_out = true;
                        let _ = self.run(&["rm", "--force", &container_name]);
                        let _ = child.kill();
                        break child.wait().map_err(|e| {
                            Error::Other(format!("failed to reap lens job client: {e}"))
                        })?;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(Error::Other(format!(
                        "failed to poll lens job client: {e}"
                    )))
                }
            }
        };

        let _ = writer.join();
        let stdout = stdout_reader
            .join()
            .map_err(|_| Error::Other("lens job stdout reader panicked".into()))?;
        let stderr_tail = stderr_reader
            .join()
            .map_err(|_| Error::Other("lens job stderr reader panicked".into()))?;

        Ok(OneShotOutcome {
            exit_code: status.code(),
            stdout,
            stderr_tail,
            timed_out,
        })
    }
}

// ── Registry client (anonymous OCI HTTP via curl) ──────────────────────────

/// Anonymous OCI-registry client shelling out to `curl` for HTTPS.
///
/// Performs the standard token dance: HEAD the manifest, follow a 401's
/// `WWW-Authenticate: Bearer` challenge to fetch an anonymous pull token,
/// retry, and read the `Docker-Content-Digest` response header. The Accept
/// list prefers index media types so multi-platform tags resolve to the
/// manifest-index digest (never a platform manifest's).
///
/// Shelling out to `curl` keeps the engine free of an HTTP/TLS dependency
/// tree; the `RegistryClient` trait is the seam where a native client can
/// replace it. Private registries (authenticated pulls) are not yet
/// supported on this rung — pin by digest or pre-pull instead.
#[derive(Debug, Clone, Default)]
pub struct CurlRegistry;

const ACCEPT: &str = "application/vnd.oci.image.index.v1+json,\
application/vnd.docker.distribution.manifest.list.v2+json,\
application/vnd.oci.image.manifest.v1+json,\
application/vnd.docker.distribution.manifest.v2+json";

impl CurlRegistry {
    fn curl(args: &[&str]) -> Result<String> {
        let output = Command::new("curl")
            .args(["-sS", "--max-time", "30"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| Error::Other(format!("failed to spawn curl: {e}")))?;
        if !output.status.success() {
            return Err(Error::Other(format!(
                "curl failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn head_manifest(url: &str, token: Option<&str>) -> Result<String> {
        let accept = format!("Accept: {ACCEPT}");
        let mut args = vec!["-I", "-H", accept.as_str()];
        let auth;
        if let Some(token) = token {
            auth = format!("Authorization: Bearer {token}");
            args.extend(["-H", auth.as_str()]);
        }
        args.push(url);
        Self::curl(&args)
    }

    fn header<'a>(response: &'a str, name: &str) -> Option<&'a str> {
        response.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim())
        })
    }

    fn status_code(response: &str) -> Option<u16> {
        response
            .lines()
            .next()?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()
    }

    /// Fetch an anonymous bearer token per the 401 challenge.
    fn fetch_token(challenge: &str, repository: &str) -> Result<String> {
        let field = |name: &str| -> Option<String> {
            let marker = format!("{name}=\"");
            let start = challenge.find(&marker)? + marker.len();
            let end = challenge[start..].find('"')? + start;
            Some(challenge[start..end].to_string())
        };
        let realm = field("realm")
            .ok_or_else(|| Error::Other("registry challenge missing realm".into()))?;
        let mut url = format!("{realm}?scope=repository:{repository}:pull");
        if let Some(service) = field("service") {
            url.push_str(&format!("&service={service}"));
        }
        let body = Self::curl(&[url.as_str()])?;
        // The token response is flat JSON; extract "token" (or
        // "access_token") without a JSON dependency.
        for key in ["\"token\":\"", "\"access_token\":\""] {
            if let Some(start) = body.find(key) {
                let start = start + key.len();
                if let Some(end) = body[start..].find('"') {
                    return Ok(body[start..start + end].to_string());
                }
            }
        }
        Err(Error::Other("registry token response had no token".into()))
    }
}

impl RegistryClient for CurlRegistry {
    fn manifest_digest(&self, reference: &str) -> Result<String> {
        let identity_err = |message: String| Error::LensIdentity {
            container: reference.to_string(),
            message,
        };

        let (host, repository, tag) = split_reference(reference);
        let url = format!("https://{host}/v2/{repository}/manifests/{tag}");

        let mut response = Self::head_manifest(&url, None)?;
        if Self::status_code(&response) == Some(401) {
            let challenge = Self::header(&response, "www-authenticate")
                .ok_or_else(|| identity_err("401 without WWW-Authenticate challenge".into()))?
                .to_string();
            let token = Self::fetch_token(&challenge, &repository)?;
            response = Self::head_manifest(&url, Some(&token))?;
        }

        match Self::status_code(&response) {
            Some(200) => {}
            other => {
                return Err(identity_err(format!(
                    "registry manifest HEAD returned status {other:?}"
                )))
            }
        }

        Self::header(&response, "docker-content-digest")
            .map(str::to_string)
            .ok_or_else(|| identity_err("registry response had no Docker-Content-Digest".into()))
    }
}

/// Split an image reference into `(registry_host, repository, tag)`.
///
/// A first path component containing `.` or `:` (or `localhost`) is a
/// registry host; otherwise the reference is a Docker Hub shortname
/// (`registry-1.docker.io`, `library/` prefix for bare names). The tag
/// defaults to `latest`.
pub fn split_reference(reference: &str) -> (String, String, String) {
    let (name, tag) = match reference.rsplit_once(':') {
        Some((n, t)) if !t.contains('/') => (n.to_string(), t.to_string()),
        _ => (reference.to_string(), "latest".to_string()),
    };

    match name.split_once('/') {
        Some((first, rest))
            if first.contains('.') || first.contains(':') || first == "localhost" =>
        {
            (first.to_string(), rest.to_string(), tag)
        }
        Some(_) => ("registry-1.docker.io".to_string(), name, tag),
        None => ("registry-1.docker.io".to_string(), format!("library/{name}"), tag),
    }
}

/// Strip the tag portion of a reference the way the oracle does
/// (`containerQuery.replace(/:.*$/, '')`): everything from the **first**
/// colon. Faithful to `lib/Lens.js` — references with a registry port would
/// mis-strip identically in both engines.
pub fn strip_tag(reference: &str) -> &str {
    match reference.find(':') {
        Some(idx) => &reference[..idx],
        None => reference,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_reference_forms() {
        assert_eq!(
            split_reference("ghcr.io/hologit/lenses/mkdocs:v2"),
            (
                "ghcr.io".to_string(),
                "hologit/lenses/mkdocs".to_string(),
                "v2".to_string()
            )
        );
        assert_eq!(
            split_reference("alpine"),
            (
                "registry-1.docker.io".to_string(),
                "library/alpine".to_string(),
                "latest".to_string()
            )
        );
        assert_eq!(
            split_reference("someorg/tool:1.2"),
            (
                "registry-1.docker.io".to_string(),
                "someorg/tool".to_string(),
                "1.2".to_string()
            )
        );
    }

    #[test]
    fn strip_tag_first_colon() {
        assert_eq!(strip_tag("ghcr.io/x/y:latest"), "ghcr.io/x/y");
        assert_eq!(strip_tag("ghcr.io/x/y"), "ghcr.io/x/y");
    }

    #[test]
    fn parse_challenge_headers() {
        let response = "HTTP/2 401 \r\nwww-authenticate: Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:x/y:pull\"\r\n\r\n";
        assert_eq!(CurlRegistry::status_code(response), Some(401));
        let challenge = CurlRegistry::header(response, "WWW-Authenticate").unwrap();
        assert!(challenge.contains("realm=\"https://ghcr.io/token\""));
    }
}
