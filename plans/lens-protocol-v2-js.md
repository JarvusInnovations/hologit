---
status: in-progress
depends: []
specs:
  - specs/behaviors/lensing.md
issues: [417, 19]
---

# Lens job protocol v2 — interim JS implementation

## Scope

Implement the exec/stdio lens job protocol from `specs/behaviors/lensing.md` in the
Node.js engine (`lib/Lens.js`), as an interim step ahead of the Rust lens executor
([`lens-execution`](lens-execution.md), #435, dep-gated on projector-napi):

- **In:** container identity-resolution ladder (digest pin → local lookup → registry;
  local-only images per #417), one-shot v2 stdio transport (bundle in on stdin, bundle
  out on stdout, per-job `refs/jobs/<spec-hash>/{input,output,error}` refs), job
  deadline/timeout (partial #19), dual-protocol detection via the
  `sh.holo.lens.protocol=2` OCI image label with the existing v1 port-9000 path kept
  intact as fallback, a reference SDK entrypoint (`lens-sdk/lens-job.sh`) that lens
  images will vendor (hologit/lenses#32), and docker-gated integration tests against a
  locally-built fixture image.
- **Out (follow-ups):** warm container pool, `ext::`-transport incremental push,
  promisor/lazy fetch, shared runtime-host object cache, the Rust executor (#435),
  migrating published lens images (hologit/lenses#32).
- **Frozen:** spec-object format and cache-ref scheme (`SpecObject.write('lens', …)`,
  `refs/holo/lens/...`, `cacheFrom`/`cacheTo`) — cache compatibility across engine
  versions is a spec requirement. Protocol version is a property of the *image*
  (label), never of the spec object. The `resolved = "local"` spec field is the one
  sanctioned spec-content addition (local-only specs are honestly non-portable).

## Implements

- `specs/behaviors/lensing.md` — § Container identity resolution (full ladder,
  including the #417 local-only branch), § Job protocol (one-shot mode + deadlines;
  warm pool and supersession deferred), § Container lifecycle (one-shot only),
  § Object transfer (tier 1 Full only), § Spec and content addressing (wrapper commit
  with `.holospec/lens.toml` + `input/`), § Principles (no hidden image contracts —
  everything the engine needs from a v2 image is the protocol label plus an
  entrypoint implementing the job protocol).

## Approach

1. **Identity ladder first** — replace the unconditional registry query in
   `buildSpecForContainer`: (a) config already pins `@sha256:` → use as-is;
   (b) `docker image inspect` on the tag → use `RepoDigests` entry when present;
   (c) local image with no repo digest (never pushed, #417) → image ID +
   `resolved = "local"` in spec data; (d) fall back to `buildx imagetools inspect`.
   The local-only branch is what makes the offline test loop possible (tests build a
   local image, never touch a registry).
2. **Reference SDK + test fixture** — `lens-sdk/lens-job.sh` (POSIX sh): read input
   bundle from stdin into a scratch bare repo, materialize the wrapper tree, run the
   spec's `command` against `input/`, commit the result as first-parent child of the
   input commit, emit the output (or structured error) bundle on stdout; stdout stays
   binary-clean, all logging on stderr. Fixture image: `alpine:3` + git + the SDK +
   deterministic test lens commands, built locally by the test suite.
3. **One-shot v2 transport** — `executeSpecForContainer` becomes a dispatcher:
   ensure image present, read `Config.Labels`, log which protocol runs, dispatch to
   the untouched v1 path or the new v2 executor. V2: wrapper commit → bundle →
   `docker run -i --rm` with piped stdio (dedicated Buffer-safe spawn helper in
   `Studio`, not string-accumulating `execDocker`) → fetch output/error ref from the
   returned bundle → verify first parent == input commit → return tree hash.
   Deadline: config `timeout` (stripped from spec data) with 600s engine default;
   on expiry `docker rm -f` the named container and raise a structured error.
4. **Tests** — jest integration suite `test/integration/lens-v2.test.js`, docker-gated
   (skip cleanly when docker unavailable): success round-trip, structured error
   propagation, timeout kill, protocol detection (unlabeled image → v1 path),
   idempotent cache hit, identity-ladder unit cases.

## Validation

- [ ] `npm test` passes (new lens-v2 suite green locally with docker; suite skips
      cleanly without docker)
- [ ] `node bin/cli.js project docs-site` and
      `node bin/cli.js project github-action-projector` still produce the expected
      hashes via the v1 fallback (published lens images carry no v2 label)
- [ ] `cargo test` passes (untouched, repo invariant)
- [ ] A local, never-pushed lens image builds a spec with `resolved = "local"` and
      executes successfully offline (#417)
- [ ] Lens failure surfaces exit code + log from the `refs/jobs/<spec-hash>/error`
      commit; timeout kills the container without leaking it
- [ ] `pr-test.yml` green on the PR (test-action is the final gate; known v1 flake
      signature = instant HTTP 500 / unexpected disconnect on port-9000 push — rerun
      before investigating)

## Risks / unknowns

- **Multi-arch digest divergence** — local `RepoDigests` may hold a platform manifest
  digest while `buildx imagetools inspect` returns the index digest, so the same image
  can produce different spec hashes depending on which ladder rung resolves. Inherent
  in the spec's offline-first ladder; flagged for a spec amendment if it bites.
- **SDK TOML parsing** — the reference SDK extracts `command` from
  `.holospec/lens.toml` with sed (POSIX sh, no TOML parser); complex quoted commands
  need care. Real lens images can ship richer SDKs; the contract is unchanged.
- **v1 path untouched** — every published `ghcr.io/hologit/lenses/*` image is v1
  today; any regression there is a hard blocker for this PR.

## Notes

- The engine invokes a v2 image's **default entrypoint** with no arguments — the
  protocol label plus "entrypoint implements the job protocol" is the whole contract
  (no hidden image contracts; the SDK path inside the image is the image's business).
- `timeout` is engine/config concern, deliberately stripped from spec data (it cannot
  change the output, so per the spec it must not enter the spec hash).
- `HOLO_DEBUG_PERSIST_CONTAINER` remains honored on the v1 path only; v2 one-shot
  containers are `--rm` and need no persistent debug container.
- Fast inner-loop recipes are documented in the PR body (single-case jest invocation,
  driving `Lens.executeSpec` from a scratch script, `docker run -i` against a
  hand-built bundle to exercise the SDK without the engine).

## Follow-ups

*(populated at closeout)*
