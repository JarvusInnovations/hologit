---
status: done
depends: []
specs:
  - specs/behaviors/composition.md
  - specs/behaviors/projection-commits.md
issues: [438]
pr: 495
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

- [x] `specs/behaviors/projection-commits.md` accepted and merged (lands with this PR)
- [x] Commit shape (tree, parents, trailers) matches JS engine output on the reference projections (`docs-site` `8c1d5581…`, `github-action-projector` `2c4ad1dd…` — identical commit hashes from `node bin/cli.js project <branch> --no-lens --commit-to=…` and `commit_projection` on the same pinned inputs, including a real tag-bearing `git describe` string)
- [x] With pinned identity/timestamp, commit hash matches the JS engine bit-for-bit (`holo-projector/tests/commit.rs` asserts raw commit bytes, then hashes, against six oracle captures; capture procedure committed as `tests/fixtures/capture-projection-commit-oracle.sh`)
- [x] `commitTo` ref advance uses CAS and surfaces a structured error on race (`REF_CONFLICT` unit test; the concurrent writer's ref value survives)

## Risks / unknowns

- JS commit-message/trailer formatting may have quirks (ordering, whitespace) that only bit-for-bit comparison reveals.

## Notes

- The risk above materialized as three ported quirks, now specced: a `--commit-message` override drops the **entire** trailer block; working-tree mode embeds the machine-specific absolute worktree path and gates `Source-commit`/`Source` on the mode (not data availability) while keeping the source commit as second parent; `git commit-tree -m` appends a trailing newline only when absent (pinned empirically).
- **Provenance is host-supplied**: the `Source`/`from` description is a parameter, never computed in the engine — reproducing `git describe --always --tags` (abbreviation rules, tag state) in gix would be an undeclared-input determinism hazard. Captured as a Local principle in the spec; the future CLI wiring passes the string in, exactly as `lib/Projection.js` computes it today.
- Two declared desired-state divergences from the oracle: CAS ref advance (`REF_CONFLICT` instead of blind `update-ref`; absent-ref creation stays unconditional), and first-parent resolution reading the ref directly with symbolic-ref following (`commit_ref: "HEAD"` advances the branch HEAD points at, matching `git update-ref HEAD`; holo-tree's `update_ref` is `deref: false`, so the deref happens during resolution).
- The dangling init commit's empty tree is materialized in the ODB (git treats it as virtually present; not every consumer does). No effect on commit bytes.
- No holo-tree changes were needed — `commit_tree` + CAS `update_ref` sufficed, as planned.

## Follow-ups

- Deferred to [`watch-mode`](watch-mode.md) — napi/CLI wiring of the Rust commit path (binding export + hybrid-dispatcher use); lands with the warm-context work, per `specs/behaviors/engine-selection.md` (JS owns commits in the hybrid CLI today).
