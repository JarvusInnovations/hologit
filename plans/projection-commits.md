---
status: in-progress
depends: []
specs:
  - specs/behaviors/composition.md
issues: [438]
---

# Projection commit creation with trailers (Rust engine)

## Scope

Wire projection-commit creation into holo-projector: after composing a tree, create a commit with the projected tree, the previous projection commit as first parent (or an init commit), the source commit as optional second parent, trailers (`Source-holobranch`, `Source-commit`, `Source`), and advance the `commitTo` ref. holo-tree's `commit_tree` and CAS `update_ref` already provide the primitives.

## Implements

- **First step:** add a `specs/behaviors/projection-commits.md` spec pinning commit shape (parents, message, trailers, ref semantics) — captured from the JS engine's behavior per the conformance-oracle principle — and get it accepted.
- Extends `specs/behaviors/composition.md` output semantics (composition stays pure; commit creation is an explicit edge capability layered on it).

## Approach

1. Spec the commit shape from `lib/Projection.js` behavior (message format, trailer set, parent rules, init-commit case, `commitTo` ref update semantics).
2. Implement in holo-projector behind an explicit API (e.g. `commit_projection(...)`) so `project_branch` itself stays side-effect-free.
3. Validate commit-hash parity with the JS engine where inputs are pinned (identity + timestamp injected), mirroring the bit-for-bit parity approach proven in the gitsheets spike.

## Validation

- [ ] `specs/behaviors/projection-commits.md` accepted and merged
- [ ] Commit shape (tree, parents, trailers) matches JS engine output on the reference projections
- [ ] With pinned identity/timestamp, commit hash matches the JS engine bit-for-bit
- [ ] `commitTo` ref advance uses CAS and surfaces a structured error on race

## Risks / unknowns

- JS commit-message/trailer formatting may have quirks (ordering, whitespace) that only bit-for-bit comparison reveals.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
