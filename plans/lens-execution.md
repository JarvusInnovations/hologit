---
status: done
depends: [projector-napi-cli]
specs:
  - specs/behaviors/composition.md
  - specs/behaviors/lensing.md
  - specs/api/lens-sdk.md
issues: [435]
pr: 500
---

# Lens execution (Rust engine) — and the container-runtime decision

## Scope

Port lens (hololens) execution to the Rust engine: build the glob-filtered input tree, compute the content-addressed spec hash, check spec-ref cache, execute the lens container on miss, merge output back per the lens's declared mode. This plan deliberately includes the **desired-state decision** on the lens runtime: whether to drop Habitat support and standardize on OCI container images only (production consumers already use `ghcr.io/hologit/lenses/*` exclusively; `HAB_LICENSE` in consumer CI is legacy friction).

## Implements

- **First step:** author `specs/behaviors/lensing.md` — lens input/spec-hash/cache/merge semantics (captured from JS behavior) **plus** the runtime decision (OCI-only vs. Habitat-compatible), which must be settled spec-first since it changes user-facing behavior rather than porting it.

## Approach

1. Spec the pure parts from `lib/Lens.js`: input-tree construction, spec hashing, `refs/holo/lens/...` cache semantics, output merge modes — these port behavior-identical.
2. Settle the runtime question in the spec (recommendation: OCI-only via a container API, with Docker/Podman as interchangeable executors; drop Habitat and the studio's Habitat coupling). Include local-image support (#417 — lenses not yet pushed to a registry).
3. Implement execution behind a trait/API boundary so composition stays pure and the executor is swappable (also the seam for remote lensing, #79, later).
4. Cache compatibility: Rust-written lens cache refs must be readable by the JS engine and vice versa during the hybrid period.
5. Lens-image migration to the v2 job protocol (SDK entrypoint, dual-protocol transition window) is tracked downstream at hologit/lenses#32. SDK-contract conformance per `specs/api/lens-sdk.md` rides with it: the base-image gaps flagged on hologit/lenses#33 (wrapper-constant exit codes, fixed-path job state) must close before the warm pool ships — per-job isolation is its precondition — and the spec's desired-state modes (git-native, warm incremental materialization) are SDK follow-ups this plan should spawn, not blockers.
6. Retire the `LENSED_SUBPROJECTION` refusal (deferred from [`projector-napi-cli`](projector-napi-cli.md)): once the engine executes lenses, recursive sub-projections with an effective lens flag lens natively instead of erroring for the dispatcher to fall back to JS (`specs/behaviors/composition.md` § Sub-projection lensing governs when lensing must apply).
7. Warm container pool and object-transfer tiers 2–4 (incremental warm-ref negotiation, lazy/promisor fetch, shared runtime-host object cache) per specs/behaviors/lensing.md — deferred here from [`lens-protocol-v2-js`](lens-protocol-v2-js.md), which shipped the interim JS engine as one-shot/tier-1 only (PR #484).

## Validation

- [x] `specs/behaviors/lensing.md` accepted, including the runtime decision (PR #482, merged 2026-07-04; OCI-only, exec/stdio job protocol, four object-transfer tiers, remoted lensing #79, local-image resolution #417, deadlines/supersession #19)
- [x] Lensed reference projections (`docs-site` mkdocs replace-merge, `github-action-projector` npm-install glob-filtered-input — pinned to the `:v2`-protocol images) produce hashes identical to the JS engine *(amended: the originally-named helm3/kustomize and tree-patch lenses have no v2-protocol images yet, so they cannot exercise the v2-only engine; the composition-spec conformance fixtures cover the same merge/filter shapes and both engines dispatch v2 on them)* — `eecd425e` / `d56c03f7`, both engines executing natively, identical spec hashes
- [x] Lens cache hits work across engines (JS-written cache honored by Rust and vice versa) — proven in both directions on all three fixtures ("found existing output tree matching holospec(…)" with no container run)
- [x] A local, unpushed lens image runs (#417 resolved: `_resolved = "local"` image-ID identity; validated with a never-pushed image, JS/Rust hash-identical)
- [ ] Warm container pool + transfer tiers 2–4 implemented behind the same job protocol (deferred from [`lens-protocol-v2-js`](lens-protocol-v2-js.md)) — not shipped; see Notes and Follow-ups (#501)
- [ ] Lensed recursive sub-projections compose-and-lens natively — the `LENSED_SUBPROJECTION` refusal and its JS fallback are retired (deferred from [`projector-napi-cli`](projector-napi-cli.md)) — engine-side native lensing landed (the lensing pipeline lenses sub-projections; composition-only entry points still refuse by design); retiring the JS fallback is dispatcher wiring, see Follow-ups (#502)

## Risks / unknowns

- Largest remaining JS surface; `lib/Studio.js` entanglement (Habitat studio) needs a deprecation story if OCI-only wins.
- Container invocation from a library crate raises embedding questions (does a napi consumer get lens execution? likely CLI-only at first — spec must say).

## Notes

- **The spec-hash crux is the `@iarna/toml` serializer.** Cross-engine cache interop hinges on byte-identical spec TOML; `holo-projector/src/lens/iarna.rs` is a quirk-faithful port (60-char array wrap, digit-grouping underscores, literal-string preference, header omission for scalar-less tables), guarded by fixtures and known-answer tests generated from the real JS `SpecObject` pipeline. If `hologit` ever bumps `@iarna/toml` majors, re-capture the fixtures.
- **Zero new Cargo dependencies.** Registry HEAD (identity rung 3) shells out to `curl` (anonymous OCI token dance); bundle exchange shells out to `git` (`bundle create`/`fetch`, whose ingest hash-verifies returned objects). Both sit behind the `RegistryClient`/`ContainerRuntime` traits, so native implementations can replace them without touching callers.
- **Published `:latest` lens images are still v1-protocol** — only `:v2` tags carry `sh.holo.lens.protocol=2`. The Rust engine refuses v1 images with `LENS_PROTOCOL` (the dispatcher-fallback signal); parity validation pinned the conformance projections to `:v2`. The repo's own lens configs migrate with hologit/lenses#32.
- **Oracle quirks ported deliberately**: tag-stripping from the *first* colon (breaks port-qualified registries identically in both engines), npm-`toposort` reverse-DFS lens ordering, JS `deepSortKeys` degrading datetimes to empty tables.
- Habitat execution is retired per the spec's runtime decision: a `package`-only lens errors with `LENS_PROTOCOL`; `package` alongside `container` still contributes the v1-compatible default `command` to the spec for hash parity.
- Rebased over `remote-source-fetching` (PR #496): the recursive-projection callback now carries `default_lens` (this plan) alongside the `fetcher` (that plan); `LensEngine.fetcher` lets `--lens --fetch` compose.

## Follow-ups

- Issue [#501](https://github.com/JarvusInnovations/hologit/issues/501) — warm lens-container pool + object-transfer tiers 2–4: blocked on per-job isolation in the images (hologit/lenses#33) and a spec-first amendment pinning the warm transport's in-container contract; the `ContainerRuntime` seam is the landing zone
- Issue [#502](https://github.com/JarvusInnovations/hologit/issues/502) — hybrid-dispatcher adoption: retire the `LENSED_SUBPROJECTION` JS fallback, napi exposure (deferred in spec until the warm pool), `cacheFrom`/`cacheTo` remote cache exchange, private-registry auth, `LENS_*` codes into the projector-napi code table
- Tracked as: hologit/lenses#32 — lens-image v2 migration (retag `latest` as v2-protocol); until then the repo's own checked-in lens configs run v1 via the JS engine
