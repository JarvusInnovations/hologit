---
status: done
depends: []
specs:
  - specs/principles.md
  - specs/api/errors.md
issues: []
pr: 490
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

- [x] `specs/api/errors.md` accepted and merged (authored spec-first in PR #490; merges with it)
- [x] No `.unwrap()`/`.expect()` reachable from public holo-tree entry points (audited; enforced where practical by lint)
- [x] `holo_tree::Error` discriminants are matchable across the napi boundary (test asserts an error kind, not a message substring)
- [x] A deliberately-injected panic in a debug test build surfaces as a catchable JS error, not a process abort
- [x] Tree cache correctness no longer depends on thread identity (test exercising cross-thread dispatch, or the design removes the possibility)
- [ ] gitsheets consumes the new tag and drops at least one string-parsing/formatted-wrap workaround

## Risks / unknowns

- The thread-local cache redesign (finding #5) may ripple through holo-projector's hot path; benchmark emergence-site before/after to guard the ~27ms warm target.
- Whether napi's panic handling is a configuration fix (feature flags) or requires a custom panic hook is unconfirmed.

## Notes

- The gitsheets-consumption criterion stays unchecked: `holo-tree-v*` releases
  are deferred, so no tag was cut and gitsheets still pins `holo-tree-v0.4.0`.
  It closes out when the v0.5.0 tag ships and gitsheets adopts the coded
  errors + `Context` API (see Follow-ups).
- Root cause of the finding-#6 abort: napi-rs's `catch_unwind` is **opt-in
  per exported fn** (`#[napi(catch_unwind)]`); without it a panic hits the
  generated `extern "C"` trampoline, which cannot unwind → SIGABRT
  (reproduced: exit 134). The binding now wraps every export body in its own
  `contained()` guard (stable `PANIC` code) with the attribute as a backstop
  for napi marshalling code.
- napi-rs custom error status gotcha: the `#[napi]` macro detects `Result`
  **syntactically** — signatures must literally spell
  `Result<T, ErrorCode>`; a type alias compiles the macro into a
  ToNapiValue bound error.
- The cache redesign is hash- and counter-identical on emergence-site
  (1,482 hits / 1,869 misses; hash `de630914…`, matching the JS engine on
  current upstream HEAD — CLAUDE.md's `0dc5566e…` predates newer
  codeforphilly.org commits) and measured faster warm (66–86 ms vs
  125–250 ms baseline on the same clone).
- `MutableTree`/`toml` taking `&Context` is a crate-level breaking change;
  the npm binding's JS API is unchanged.

## Follow-ups

- Tracked as: `holo-tree-v0.5.0` tag deferred (releases paused) — cutting it
  and bumping gitsheets (typed-error mapping onto the new codes, `Context`
  adoption, dropping its formatted-string wraps) is the downstream half of
  findings #4/#5/#6.
- Tracked as: extend the panic audit + `cfg_attr(not(test), warn(...))` lint
  gate to holo-projector's public paths (its `walk_mappings`/projection
  helpers still `.unwrap()`), before it ships behind an FFI binding — same
  policy, `specs/api/errors.md` § Panic policy.
