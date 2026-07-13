//! Container identity resolution (`specs/behaviors/lensing.md` § Container
//! identity resolution): resolve a configured container reference to the
//! stable execution identity that enters the spec hash.
//!
//! The ladder, tried in order at spec-build time:
//!
//! 1. **Explicit digest pin** — used as-is, no lookup (offline, and the
//!    recommended form).
//! 2. **Local engine lookup** — the repo digest of a locally-present image;
//!    a never-pushed image (#417) resolves to its image ID with the
//!    `_resolved = "local"` bookkeeping marker (honestly non-portable).
//! 3. **Registry lookup** — a manifest HEAD request against the registry.
//!
//! Local shadowing (rung 2 before rung 3) is by design: a warm cache must be
//! usable offline, and the remedy for staleness is digest pinning.

use super::job::is_digest_reference;
use super::runtime::{strip_tag, ContainerRuntime, RegistryClient};
use crate::error::Result;

/// A resolved container execution identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerIdentity {
    /// The identity that enters the spec: `name@sha256:…`, or a bare image
    /// ID for locally-resolved images.
    pub container: String,
    /// True when resolved from a never-pushed local image (#417); becomes
    /// `_resolved = "local"` in the spec.
    pub local: bool,
}

/// Resolve a configured container reference via the ladder.
pub fn resolve(
    runtime: &dyn ContainerRuntime,
    registry: &dyn RegistryClient,
    container_query: &str,
) -> Result<ContainerIdentity> {
    // 1. explicit digest pin — no lookup performed
    if is_digest_reference(container_query) {
        return Ok(ContainerIdentity {
            container: container_query.to_string(),
            local: false,
        });
    }

    // 2. local engine lookup
    if let Some(image) = runtime.inspect_local(container_query)? {
        let repo_name = strip_tag(container_query);
        let prefix = format!("{repo_name}@");
        let matching = image
            .repo_digests
            .iter()
            .find(|d| d.starts_with(&prefix))
            .or_else(|| image.repo_digests.first());

        if let Some(digest) = matching {
            eprintln!("resolved container identity from local image: {digest}");
            return Ok(ContainerIdentity {
                container: digest.clone(),
                local: false,
            });
        }

        // local-only image, never pushed (#417): use image ID, marked local
        eprintln!(
            "resolved local-only container identity: {} ({container_query})",
            image.id
        );
        return Ok(ContainerIdentity {
            container: image.id,
            local: true,
        });
    }

    // 3. registry lookup
    let digest = registry.manifest_digest(container_query)?;
    eprintln!("resolved container identity from registry: {container_query} → {digest}");
    Ok(ContainerIdentity {
        container: format!("{}@{digest}", strip_tag(container_query)),
        local: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::lens::runtime::{LocalImage, OneShotOutcome};
    use std::time::Duration;

    struct FakeRuntime {
        image: Option<LocalImage>,
    }

    impl ContainerRuntime for FakeRuntime {
        fn inspect_local(&self, _reference: &str) -> Result<Option<LocalImage>> {
            Ok(self.image.clone())
        }
        fn pull(&self, _reference: &str) -> Result<()> {
            Ok(())
        }
        fn protocol_label(&self, _reference: &str) -> Result<Option<String>> {
            Ok(Some("2".into()))
        }
        fn run_one_shot(
            &self,
            _image: &str,
            _spec_hash: &str,
            _input_bundle: &[u8],
            _deadline: Duration,
        ) -> Result<OneShotOutcome> {
            unreachable!("identity resolution never runs containers")
        }
    }

    struct FakeRegistry {
        digest: Option<String>,
    }

    impl RegistryClient for FakeRegistry {
        fn manifest_digest(&self, reference: &str) -> Result<String> {
            self.digest.clone().ok_or(Error::LensIdentity {
                container: reference.to_string(),
                message: "offline".into(),
            })
        }
    }

    const DIGEST: &str = "sha256:6b6b0bdb5beb2b3f852cc1cdfb7d2a67fc036bce7f26ac63efc39e8e2a2a4738";

    #[test]
    fn digest_pin_short_circuits() {
        let runtime = FakeRuntime { image: None };
        let registry = FakeRegistry { digest: None };
        let pinned = format!("ghcr.io/x/y@{DIGEST}");
        let id = resolve(&runtime, &registry, &pinned).unwrap();
        assert_eq!(id.container, pinned);
        assert!(!id.local);
    }

    #[test]
    fn local_repo_digest_wins_and_matches_repo() {
        let runtime = FakeRuntime {
            image: Some(LocalImage {
                id: "sha256:localid".into(),
                repo_digests: vec![
                    format!("other.registry/mirror@{DIGEST}"),
                    format!("ghcr.io/x/y@{DIGEST}"),
                ],
            }),
        };
        let registry = FakeRegistry { digest: None };
        let id = resolve(&runtime, &registry, "ghcr.io/x/y:latest").unwrap();
        // prefers the digest matching the configured repo, not the first
        assert_eq!(id.container, format!("ghcr.io/x/y@{DIGEST}"));
        assert!(!id.local);
    }

    #[test]
    fn local_only_image_marks_resolved_local() {
        let runtime = FakeRuntime {
            image: Some(LocalImage {
                id: "sha256:abc123".into(),
                repo_digests: vec![],
            }),
        };
        let registry = FakeRegistry { digest: None };
        let id = resolve(&runtime, &registry, "my-local-lens:dev").unwrap();
        assert_eq!(id.container, "sha256:abc123");
        assert!(id.local);
    }

    #[test]
    fn registry_fallback() {
        let runtime = FakeRuntime { image: None };
        let registry = FakeRegistry {
            digest: Some(DIGEST.into()),
        };
        let id = resolve(&runtime, &registry, "ghcr.io/x/y:latest").unwrap();
        assert_eq!(id.container, format!("ghcr.io/x/y@{DIGEST}"));
        assert!(!id.local);
    }
}
