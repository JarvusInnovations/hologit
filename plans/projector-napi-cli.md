---
status: in-progress
depends: []
specs:
  - specs/architecture.md
  - specs/behaviors/composition.md
  - specs/behaviors/engine-selection.md
  - specs/api/projector-napi.md
issues: [434]
---

# Wire the Rust projector into the Node CLI (holo-projector-napi)

## Scope

Create a `holo-projector-napi` crate exposing `project_branch()` and `project_plan()` to Node.js, and make the CLI delegate pure composition to it. The interim CLI is a hybrid: JS keeps ownership of side effects (fetching, lensing, commits, watch) and calls into Rust for composition. This is the linchpin plan — it turns the validated Rust engine into shipped behavior and unlocks the rest of the migration chain.

## Implements

- `specs/architecture.md` (Migration strategy step 2)
- `specs/behaviors/composition.md` (the Rust engine becomes the production implementation of this behavior)

## Approach

1. New workspace crate `holo-projector-napi` following the holo-tree-napi packaging pattern (platform prebuilds, trusted publishing, prefix-namespaced tags — decide tag prefix, e.g. `holo-projector-v*`, never bare `v*`).
2. Integration points: `Projection.projectBranch()` → `project_branch(git_dir, ref, branch_name)`; `ProjectionPlan.project()` → `project_plan(git_dir, sources, mappings)`.
3. Delegation policy in JS: use Rust when the projection needs composition only (no lensing, all sources local); fall back to the JS engine otherwise. Fallback must be observable (debug log), never silent behavior divergence.
4. Wire `test-cli` CI to run both engines on the reference projections and assert hash equality (the conformance fixtures in `specs/behaviors/composition.md`).

## Validation

- [ ] `git holo project docs-site` and `github-action-projector` produce reference hashes via the Rust path
- [ ] emergence-site (codeforphilly.org) hash-identical via the Rust path
- [ ] Lensed/unfetched projections still work via JS fallback with an observable fallback signal
- [ ] CI gate asserts JS/Rust hash equality on the fixtures
- [ ] No regression on cold/warm benchmark targets (~100ms cold / ~27ms warm on emergence-site)

## Risks / unknowns

- Where to draw the hybrid seam when a projection mixes lensed and unlensed holobranches (recursive sub-projections may lens); may need per-sub-projection delegation rather than per-invocation.
- FFI robustness debt (see `holo-tree-ffi-robustness`) becomes CLI-facing once the CLI embeds the engine — not a hard dependency, but panics aborting `git holo` would regress UX; coordinate ordering.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
