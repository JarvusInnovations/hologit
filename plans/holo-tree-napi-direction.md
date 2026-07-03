---
status: planned
depends: [holo-tree-ffi-robustness]
specs:
  - specs/architecture.md
issues: [464]
---

# Decide @hologit/holo-tree's direction, then take the optimization paths that fit

## Scope

The napi binding's designed consumer (gitsheets) now links holo-tree as a Cargo crate and no longer uses the npm package. Decide the binding's future explicitly — standalone public primitive (git tree/ref/blob CRUD for Node, godrive-style embedders as the audience) vs. frozen stepping-stone — then work the #464 optimization backlog (per-call `to_thread_local()`, gix object cache default-off, `cache_read` vec clone, release-build guidance) only to the level the decision justifies.

## Implements

- `specs/architecture.md` (Embedding consumers) — the decision updates this spec's description of the binding's role.

## Approach

1. Decide and record the direction in `specs/architecture.md` (spec-first: this is desired state).
2. If "public primitive": README positioning, the #464 optimizations (several overlap with the FFI-robustness cache redesign — hence the dependency), and a supported-surface statement.
3. If "frozen": mark the npm package's README accordingly, close #464 as wontfix-for-now, keep `holo-tree-v*` tags serving Cargo consumers only.

## Validation

- [ ] `specs/architecture.md` updated with the binding's declared role
- [ ] #464 either executed (benchmarked improvement recorded) or closed with rationale
- [ ] npm package README states its support posture

## Risks / unknowns

- Unknown external npm consumers (the package is public); check download stats before freezing.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
