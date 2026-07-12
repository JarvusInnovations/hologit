---
status: done
depends: []
specs:
  - specs/architecture.md
  - specs/behaviors/composition.md
  - specs/behaviors/engine-selection.md
  - specs/api/projector-napi.md
issues: [434]
pr: 492
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

- [x] `git holo project docs-site` and `github-action-projector` produce reference hashes via the Rust path (parity with the JS oracle on the same HEAD: `docs-site` lensed `eecd425e…` both engines; pre-lens intermediates also identical)
- [x] emergence-site (codeforphilly.org) hash-identical via the Rust path (`de630914…` both engines at upstream `c491905`)
- [x] Lensed/unfetched projections still work via JS fallback with an observable fallback signal (single logged reason line; jest plan tests exercise the unfetched-source fallback; the Rust engine refuses lensed sub-projections with `LENSED_SUBPROJECTION`)
- [x] CI gate asserts JS/Rust hash equality on the fixtures (`test-cli` runs both projections under `HOLO_ENGINE=js` and `HOLO_ENGINE=rust` and diffs the hashes; `rust` errors instead of falling back, proving the Rust path ran)
- [x] No regression on cold/warm benchmark targets (engine-level bench CLI: 106ms cold on emergence-site, hash-identical; the ~27ms warm figure applies to in-process cache reuse, which the per-call binding deliberately doesn't hold — see Notes)

## Risks / unknowns

- Where to draw the hybrid seam when a projection mixes lensed and unlensed holobranches (recursive sub-projections may lens); may need per-sub-projection delegation rather than per-invocation.
- FFI robustness debt (see `holo-tree-ffi-robustness`) becomes CLI-facing once the CLI embeds the engine — not a hard dependency, but panics aborting `git holo` would regress UX; coordinate ordering.

## Notes

- **The seam landed per-phase, not per-invocation**: a new `composite_branch` engine entry point emits the *pre-lens* tree (`.holo/{branches,sources}` stripped, final `.holo` strip skipped), and the JS pipeline (lensing, final strip, commit) continues on it. Lens inputs are content-addressed, so pre-lens parity implies lensed-output parity — verified end-to-end on docs-site with the real mkdocs lens.
- **The lensed-sub-projection risk resolved as refusal + JS recursion**: the Rust engine computes the oracle's effective-lens flag per sub-projection and errors (`LENSED_SUBPROJECTION`) when a lens would actually fire — it previously *silently skipped* sub-projection lensing, a latent wrong-hash bug now specced (`specs/behaviors/composition.md` § Sub-projection lensing) and regression-tested. On fallback, JS's per-source recursion re-dispatches sibling sub-projections through the hybrid path, so one lensing sub-projection doesn't drag its graph off the Rust engine.
- The binding opens the repo and builds a fresh `TreeCache` per call (~110–130ms per composition on emergence-site). The engine's `*_in` Context variants already support host-owned warm caches; holding one across calls is watch-mode's problem (deferred below). The handle carries holo-tree-napi's 16 MiB gix object cache (PR #491's `OBJECT_CACHE_BYTES`); the cross-call thread-id memoization (`local_repo`) from that PR is inapplicable to one-shot entry points and lands with the warm context.
- FFI-robustness ordering worked out: #490 landed first, and this binding copied its proven `contained()`/`catch_unwind`/`__triggerPanicForTest` pattern wholesale.
- Upstream codeforphilly HEAD moved past the historically pinned emergence-site hash; the conformance invariant is engine-vs-engine parity on the same commit (spec + CLAUDE.md updated).
- `node --test test/` (directory form) silently fails on node 22.22.x; the binding's test script uses the `test/*.mjs` glob form instead.

## Follow-ups

- Issue [#493](https://github.com/JarvusInnovations/hologit/issues/493) — publish `@hologit/holo-projector` (platform prebuilds, trusted publishing, `holo-projector-v*` tag track; never bare `v*`)
- Deferred to [`lens-execution`](lens-execution.md) — native lensing removes the `LENSED_SUBPROJECTION` refusal/fallback for lensed sub-projections
- Deferred to [`watch-mode`](watch-mode.md) — warm engine context across binding calls (persistent repo handle + `TreeCache` via the `*_in` variants) so repeat projections hit the ~27ms warm target
