---
status: planned
depends: []
specs:
  - specs/principles.md
issues: []
---

# holo-tree FFI robustness

## Scope

Make holo-tree safe to embed: no panics reachable from public entry points, structured error discriminants that survive FFI, and no correctness dependence on thread-implicit state. Driven by the still-open findings from gitsheets' holo-tree spike (`gitsheets:notes/holo-tree-findings.md` #4, #5, #6; #7 is already resolved — `update_ref` now supports compare-and-swap).

## Implements

- `specs/principles.md#never-abort-a-host-process`
- **First step:** author `specs/api/errors.md` — the holo-tree error contract (stable error codes/kinds, panic policy, thread-safety expectations for embedding consumers) — and get it accepted before code changes.

## Approach

1. Spec the error contract (`specs/api/errors.md`), using the gitsheets findings log as the hostile-consumer review it already is.
2. Audit public paths in holo-tree for `.unwrap()`/`.expect()`/indexing on invariants; convert to `Result` with the specced error kinds. Ensure `holo_tree::Error` exposes a stable, matchable discriminant (it already carries stable error codes — verify coverage and FFI visibility through holo-tree-napi's error mapping).
3. Address the thread-local tree cache: either a repo-bound tree/session handle that owns its cache, or an explicit cache object the consumer passes — eliminating silent misses (or corruption) if a host dispatches one logical operation across threads.
4. Verify the napi boundary converts any residual panic into a catchable error (napi `catch_unwind` behavior) rather than an abort.
5. Notify gitsheets (its `transaction.rs` wraps holo-tree failures as formatted strings) so it can adopt the structured discriminants; cut a `holo-tree-v*` tag.

## Validation

- [ ] `specs/api/errors.md` accepted and merged
- [ ] No `.unwrap()`/`.expect()` reachable from public holo-tree entry points (audited; enforced where practical by lint)
- [ ] `holo_tree::Error` discriminants are matchable across the napi boundary (test asserts an error kind, not a message substring)
- [ ] A deliberately-injected panic in a debug test build surfaces as a catchable JS error, not a process abort
- [ ] Tree cache correctness no longer depends on thread identity (test exercising cross-thread dispatch, or the design removes the possibility)
- [ ] gitsheets consumes the new tag and drops at least one string-parsing/formatted-wrap workaround

## Risks / unknowns

- The thread-local cache redesign (finding #5) may ripple through holo-projector's hot path; benchmark emergence-site before/after to guard the ~27ms warm target.
- Whether napi's panic handling is a configuration fix (feature flags) or requires a custom panic hook is unconfirmed.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
