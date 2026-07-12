---
status: planned
depends: [projector-napi-cli]
specs:
  - specs/behaviors/composition.md
  - specs/behaviors/lensing.md
  - specs/api/lens-sdk.md
issues: [435]
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
- [ ] Lensed reference projections (cfp-live-cluster-style helm3/kustomize, wmata-style tree-patch) produce hashes identical to the JS engine
- [ ] Lens cache hits work across engines (JS-written cache honored by Rust and vice versa)
- [ ] A local, unpushed lens image runs (#417 resolved or explicitly deferred in the spec)
- [ ] Warm container pool + transfer tiers 2–4 implemented behind the same job protocol (deferred from [`lens-protocol-v2-js`](lens-protocol-v2-js.md))
- [ ] Lensed recursive sub-projections compose-and-lens natively — the `LENSED_SUBPROJECTION` refusal and its JS fallback are retired (deferred from [`projector-napi-cli`](projector-napi-cli.md))

## Risks / unknowns

- Largest remaining JS surface; `lib/Studio.js` entanglement (Habitat studio) needs a deprecation story if OCI-only wins.
- Container invocation from a library crate raises embedding questions (does a napi consumer get lens execution? likely CLI-only at first — spec must say).

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
