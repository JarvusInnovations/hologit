//! Remote source fetching tests (`specs/behaviors/source-resolution.md`):
//! ref layout, lazy resolve-or-fetch, refresh rules, tag peeling through
//! fetch, local-ref exclusion, gitlink recovery, error codes, and the
//! concurrent multi-source stress guard (issue #450 class).

mod helpers;

use std::sync::atomic::{AtomicUsize, Ordering};

use gix::ObjectId;
use helpers::*;
use holo_projector::{FetchKind, GitCliFetcher, SourceFetcher};

// ── Local helpers ───────────────────────────────────────────────────────────

fn file_url(sb: &Sandbox) -> String {
    format!("file://{}", sb.dir.path().display())
}

/// The spec-ref path the JS engine would use for `url` + `git_ref`
/// (`refs/holo/source/{hash[0:2]}/{hash[2:]}/{ref minus "refs/"}`).
fn expected_spec_ref(url: &str, git_ref: &str) -> String {
    let hash = holo_projector::source::compute_spec_hash(url).unwrap();
    format!(
        "refs/holo/source/{}/{}/{}",
        &hash[..2],
        &hash[2..],
        git_ref.strip_prefix("refs/").unwrap()
    )
}

fn resolve_ref(sb: &Sandbox, name: &str) -> Option<ObjectId> {
    sb.repo
        .find_reference(name)
        .ok()
        .map(|r| r.target().id().to_owned())
}

/// Write an annotated tag object in `sb` pointing at `target` and return
/// the tag object's id.
fn write_annotated_tag(sb: &Sandbox, name: &str, target: ObjectId) -> ObjectId {
    let tag = gix::objs::Tag {
        target,
        target_kind: gix::object::Kind::Commit,
        name: name.into(),
        tagger: Some(gix::actor::Signature {
            name: "Test".into(),
            email: "test@test".into(),
            time: gix::date::Time::new(1700000000, 0),
        }),
        message: format!("tag {name}\n").into(),
        pgp_signature: None,
    };
    let id = sb.repo.write_object(&tag).unwrap().detach();
    sb.set_ref(&format!("refs/tags/{name}"), id);
    id
}

/// A fetcher wrapper that counts invocations (to prove the no-implicit-
/// refresh rule: an existing spec-ref must never trigger a fetch).
struct CountingFetcher<'a> {
    inner: &'a dyn SourceFetcher,
    calls: AtomicUsize,
}

impl<'a> CountingFetcher<'a> {
    fn new(inner: &'a dyn SourceFetcher) -> Self {
        Self {
            inner,
            calls: AtomicUsize::new(0),
        }
    }
}

impl SourceFetcher for CountingFetcher<'_> {
    fn fetch(&self, url: &str, git_ref: &str, kind: FetchKind) -> holo_projector::error::Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.fetch(url, git_ref, kind)
    }
}

/// A consumer workspace with one url-bearing source mapped by one branch.
fn url_source_workspace(consumer: &Sandbox, url: &str, git_ref: &str) -> ObjectId {
    consumer.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        sources: vec![(
            "dep".into(),
            SourceSpec {
                url: Some(url.into()),
                git_ref: Some(git_ref.into()),
                ..Default::default()
            },
        )],
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![("_dep".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        ..Default::default()
    })
}

// ── Lazy resolve-or-fetch ───────────────────────────────────────────────────

#[test]
fn lazy_fetch_resolves_unfetched_url_source() {
    let remote = Sandbox::new();
    let remote_tree = remote.write_tree(&[("hello.txt", "world")]);
    let remote_commit = remote.commit(remote_tree, None, "v1");
    remote.set_ref("refs/heads/master", remote_commit);

    let consumer = Sandbox::new();
    let url = file_url(&remote);
    let root = url_source_workspace(&consumer, &url, "refs/heads/master");

    // Without a fetcher: pure resolution fails with SOURCE_RESOLUTION
    holo_projector::reset();
    let err = holo_projector::project_branch(&consumer.repo, root, "site").unwrap_err();
    assert_eq!(err.code(), "SOURCE_RESOLUTION");

    // With a fetcher: fetched, resolved, and composed
    let fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    let result =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &fetcher).unwrap();
    assert_eq!(result, remote_tree, "output should be the remote tree");

    // The spec-ref was written at the exact JS-layout path
    let spec_ref = expected_spec_ref(&url, "refs/heads/master");
    assert_eq!(resolve_ref(&consumer, &spec_ref), Some(remote_commit));

    // The spec blob is pinned at refs/holo/spec/{hash} with canonical TOML
    let (spec_hash, spec_toml) = holo_projector::source::compute_spec(&url).unwrap();
    let pin = resolve_ref(&consumer, &format!("refs/holo/spec/{spec_hash}")).unwrap();
    assert_eq!(pin.to_string(), spec_hash);
    let blob = consumer.repo.find_object(pin).unwrap();
    assert_eq!(blob.data, spec_toml.as_bytes());
}

#[test]
fn second_projection_resolves_without_fetching() {
    let remote = Sandbox::new();
    let remote_tree = remote.write_tree(&[("a.txt", "1")]);
    let remote_commit = remote.commit(remote_tree, None, "v1");
    remote.set_ref("refs/heads/master", remote_commit);

    let consumer = Sandbox::new();
    let url = file_url(&remote);
    let root = url_source_workspace(&consumer, &url, "refs/heads/master");

    let git_fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    holo_projector::project_branch_fetching(&consumer.repo, root, "site", &git_fetcher).unwrap();

    // Second run: spec-ref present, fetcher must not be invoked at all
    let counting = CountingFetcher::new(&git_fetcher);
    holo_projector::reset();
    let result =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &counting).unwrap();
    assert_eq!(result, remote_tree);
    assert_eq!(counting.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn existing_spec_ref_is_never_implicitly_refreshed() {
    let remote = Sandbox::new();
    let tree_v1 = remote.write_tree(&[("a.txt", "v1")]);
    let commit_v1 = remote.commit(tree_v1, None, "v1");
    let tree_v2 = remote.write_tree(&[("a.txt", "v2")]);
    let commit_v2 = remote.commit(tree_v2, Some(commit_v1), "v2");
    remote.set_ref("refs/heads/master", commit_v2);

    let consumer = Sandbox::new();
    let url = file_url(&remote);
    let root = url_source_workspace(&consumer, &url, "refs/heads/master");

    // Pre-populate the spec-ref at v1 (as a previous fetch would have);
    // make the object available locally too.
    let spec_ref = expected_spec_ref(&url, "refs/heads/master");
    let tree_v1_local = consumer.write_tree(&[("a.txt", "v1")]);
    let commit_v1_local = consumer.commit(tree_v1_local, None, "v1");
    assert_eq!(commit_v1_local, commit_v1, "fixture commits must match");
    consumer.set_ref(&spec_ref, commit_v1);

    // Projection with fetching enabled must use the cached v1, not v2
    let fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    let result =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &fetcher).unwrap();
    assert_eq!(result, tree_v1, "cached spec-ref must win; no implicit refresh");
    assert_eq!(resolve_ref(&consumer, &spec_ref), Some(commit_v1));
}

// ── Tag handling ────────────────────────────────────────────────────────────

#[test]
fn fetched_annotated_tag_stays_unpeeled_and_peels_at_resolution() {
    let remote = Sandbox::new();
    let remote_tree = remote.write_tree(&[("tagged.txt", "content")]);
    let remote_commit = remote.commit(remote_tree, None, "release");
    remote.set_ref("refs/heads/master", remote_commit);
    let tag_id = write_annotated_tag(&remote, "v1.0.0", remote_commit);

    let consumer = Sandbox::new();
    let url = file_url(&remote);
    let root = url_source_workspace(&consumer, &url, "refs/tags/v1.0.0");

    let fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    let result =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &fetcher).unwrap();
    assert_eq!(result, remote_tree);

    // The cached ref stores the tag object itself, unpeeled (byte-compatible
    // with `git fetch`); peeling happened at resolution time.
    let spec_ref = expected_spec_ref(&url, "refs/tags/v1.0.0");
    assert_eq!(resolve_ref(&consumer, &spec_ref), Some(tag_id));

    // And no tag-following side effects: refs/tags stays empty locally
    assert_eq!(resolve_ref(&consumer, "refs/tags/v1.0.0"), None);
}

// ── Resolution-order guarantees ─────────────────────────────────────────────

#[test]
fn url_source_never_falls_through_to_local_ref() {
    // A url-bearing source with no spec-ref must NOT resolve via a
    // same-named local ref in the containing repo.
    let consumer = Sandbox::new();
    let decoy_tree = consumer.write_tree(&[("decoy.txt", "wrong repo")]);
    let decoy_commit = consumer.commit(decoy_tree, None, "decoy");
    consumer.set_ref("refs/heads/master", decoy_commit);

    let root = url_source_workspace(
        &consumer,
        "file:///nonexistent/never-fetched",
        "refs/heads/master",
    );

    holo_projector::reset();
    let err = holo_projector::project_branch(&consumer.repo, root, "site").unwrap_err();
    assert_eq!(
        err.code(),
        "SOURCE_RESOLUTION",
        "must refuse rather than resolve the containing repo's ref"
    );
}

#[test]
fn local_ref_still_resolves_urlless_sources() {
    let consumer = Sandbox::new();
    let tree = consumer.write_tree(&[("local.txt", "here")]);
    let commit = consumer.commit(tree, None, "local");
    consumer.set_ref("refs/heads/vendor", commit);

    let root = consumer.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        sources: vec![(
            "dep".into(),
            SourceSpec {
                url: None,
                git_ref: Some("refs/heads/vendor".into()),
                ..Default::default()
            },
        )],
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![("_dep".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        ..Default::default()
    });

    holo_projector::reset();
    let result = holo_projector::project_branch(&consumer.repo, root, "site").unwrap();
    assert_eq!(result, tree);
}

// ── Error codes ─────────────────────────────────────────────────────────────

#[test]
fn fetch_failure_is_source_fetch_coded() {
    let consumer = Sandbox::new();
    let root = url_source_workspace(
        &consumer,
        "file:///nonexistent/no-such-remote",
        "refs/heads/master",
    );

    let fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    let err =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &fetcher).unwrap_err();
    assert_eq!(err.code(), "SOURCE_FETCH");
}

#[test]
fn unqualified_ref_is_rejected() {
    let consumer = Sandbox::new();
    let fetcher = GitCliFetcher::new(&consumer.repo);
    let err = fetcher
        .fetch("file:///anywhere", "master", FetchKind::Shallow)
        .unwrap_err();
    assert_eq!(err.code(), "SOURCE_FETCH");
}

// ── Gitlink recovery ────────────────────────────────────────────────────────

#[test]
fn gitlink_recovery_fetches_missing_tip_commit() {
    let remote = Sandbox::new();
    let remote_tree = remote.write_tree(&[("pinned.txt", "tip")]);
    let remote_commit = remote.commit(remote_tree, None, "tip");
    remote.set_ref("refs/heads/master", remote_commit);

    let consumer = Sandbox::new();
    let url = file_url(&remote);
    let root = consumer.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        sources: vec![(
            "dep".into(),
            SourceSpec {
                url: Some(url.clone()),
                git_ref: Some("refs/heads/master".into()),
                ..Default::default()
            },
        )],
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![("_dep".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        gitlinks: vec![("dep".into(), remote_commit)],
        ..Default::default()
    });

    // Without a fetcher the gitlink commit is dangling
    holo_projector::reset();
    assert!(holo_projector::project_branch(&consumer.repo, root, "site").is_err());

    let fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    let result =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &fetcher).unwrap();
    assert_eq!(result, remote_tree);
}

#[test]
fn gitlink_recovery_unshallows_for_non_tip_commit() {
    // The pinned commit is the tip's PARENT: a depth-1 fetch can't supply it,
    // so recovery must escalate to the history-completing refs/heads/* fetch.
    let remote = Sandbox::new();
    let tree_v1 = remote.write_tree(&[("pinned.txt", "old")]);
    let commit_v1 = remote.commit(tree_v1, None, "v1");
    let tree_v2 = remote.write_tree(&[("pinned.txt", "new")]);
    let commit_v2 = remote.commit(tree_v2, Some(commit_v1), "v2");
    remote.set_ref("refs/heads/master", commit_v2);

    let consumer = Sandbox::new();
    let url = file_url(&remote);
    let root = consumer.write_holo_workspace(&WorkspaceSpec {
        name: "myapp".into(),
        sources: vec![(
            "dep".into(),
            SourceSpec {
                url: Some(url.clone()),
                git_ref: Some("refs/heads/master".into()),
                ..Default::default()
            },
        )],
        branches: vec![(
            "site".into(),
            BranchSpec {
                mappings: vec![("_dep".into(), MappingSpec::default())],
                ..Default::default()
            },
        )],
        gitlinks: vec![("dep".into(), commit_v1)],
        ..Default::default()
    });

    let fetcher = GitCliFetcher::new(&consumer.repo);
    holo_projector::reset();
    let result =
        holo_projector::project_branch_fetching(&consumer.repo, root, "site", &fetcher).unwrap();
    assert_eq!(result, tree_v1, "gitlink pins v1 even though the tip is v2");
}

// ── Concurrency: the #450 regression guard ──────────────────────────────────

#[test]
fn concurrent_multi_source_fetch_is_race_free() {
    const SOURCES: usize = 15;
    const ITERATIONS: usize = 5;

    // 15 distinct remotes, each with 2 commits so depth-1 fetches actually
    // engage .git/shallow in the consumer.
    let remotes: Vec<Sandbox> = (0..SOURCES)
        .map(|i| {
            let r = Sandbox::new();
            let t1 = r.write_tree(&[("f.txt", &format!("base-{i}"))]);
            let c1 = r.commit(t1, None, "base");
            let t2 = r.write_tree(&[("f.txt", &format!("tip-{i}"))]);
            let c2 = r.commit(t2, Some(c1), "tip");
            r.set_ref("refs/heads/master", c2);
            r
        })
        .collect();

    let consumer = Sandbox::new();

    for iteration in 0..ITERATIONS {
        let results: Vec<holo_projector::error::Result<String>> = std::thread::scope(|s| {
            remotes
                .iter()
                .map(|remote| {
                    let git_dir = consumer.repo.git_dir().to_path_buf();
                    let url = file_url(remote);
                    s.spawn(move || {
                        let fetcher = GitCliFetcher::for_git_dir(git_dir);
                        fetcher.fetch(&url, "refs/heads/master", FetchKind::Shallow)
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect()
        });

        for (i, result) in results.iter().enumerate() {
            assert!(
                result.is_ok(),
                "iteration {iteration}, source {i}: fetch failed: {:?}",
                result.as_ref().err()
            );
        }
    }

    // Every source's spec-ref resolves to its remote tip
    for remote in &remotes {
        let url = file_url(remote);
        let spec_ref = expected_spec_ref(&url, "refs/heads/master");
        let expected = remote
            .repo
            .find_reference("refs/heads/master")
            .unwrap()
            .target()
            .id()
            .to_owned();
        assert_eq!(resolve_ref(&consumer, &spec_ref), Some(expected));
    }
}
