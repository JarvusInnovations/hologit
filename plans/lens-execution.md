---
status: planned
depends: [projector-napi-cli]
specs:
  - specs/behaviors/composition.md
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

## Validation

- [ ] `specs/behaviors/lensing.md` accepted, including the runtime decision
- [ ] Lensed reference projections (cfp-live-cluster-style helm3/kustomize, wmata-style tree-patch) produce hashes identical to the JS engine
- [ ] Lens cache hits work across engines (JS-written cache honored by Rust and vice versa)
- [ ] A local, unpushed lens image runs (#417 resolved or explicitly deferred in the spec)

## Risks / unknowns

- Largest remaining JS surface; `lib/Studio.js` entanglement (Habitat studio) needs a deprecation story if OCI-only wins.
- Container invocation from a library crate raises embedding questions (does a napi consumer get lens execution? likely CLI-only at first — spec must say).

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
