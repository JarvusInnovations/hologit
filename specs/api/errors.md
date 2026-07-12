# API: holo-tree error contract

The failure contract for `holo-tree` as an **embedded library**: the stable error
codes consumers match on, the panic policy that keeps a violated invariant from
taking down a host process, and the thread-safety expectations embedding
consumers can rely on (and must uphold).

## Applies to

- The `holo-tree` crate's public API (everything reachable from `holo_tree::*`).
- The `@hologit/holo-tree` napi binding (`holo-tree-napi`), which is the same
  contract projected onto JS: every failure is a catchable `Error` carrying a
  stable `code` property.
- `holo-projector` inherits the crate-level contract for the `holo_tree::Error`
  variants it forwards (`holo_projector::Error::Tree`).

This contract was driven by hostile-consumer review from gitsheets, the first
embedded consumer (`gitsheets:notes/holo-tree-findings.md` findings #4, #5, #6).

## Error codes

Every `holo_tree::Error` exposes a **stable, machine-matchable code** via
`Error::code()`. The napi binding surfaces the same code as the thrown JS
error's `code` property. Codes — not message text — are the API.

| Code | Rust variant | Raised when |
| --- | --- | --- |
| `GIT` | `Error::Git` | An underlying git operation (ODB read/write, ref edit, rev-parse, repo open) failed in a way holo-tree does not classify further. |
| `OBJECT_NOT_FOUND` | `Error::ObjectNotFound` | An object id that was expected to exist in the ODB does not — e.g. placing a blob by hash (`write_child_hash`) when the hash is unknown, or loading a tree whose object dangles. |
| `NOT_A_TREE` | `Error::NotATree` | An object or path component expected to be a tree is some other kind — e.g. writing through `a/b/c` when `a/b` is a blob, or navigating into a non-tree object. |
| `PATH_NOT_FOUND` | `Error::PathNotFound` | A fixed path could not be fully navigated where existence is required (`create_tree_from_path`). Operations specced to return "absent" (`read_blob`, `get_child`, `resolve_ref`) signal absence with `None`/`null`, **not** with this error. |
| `GLOB` | `Error::Glob` | A glob pattern failed to compile. |
| `TOML` | `Error::Toml` | A TOML blob is non-UTF-8 or failed to parse. |
| `INVALID_ARGUMENT` | `Error::InvalidArgument` | A caller-supplied value is malformed regardless of repository state: a non-hex object id, an invalid blob filemode, an unknown merge mode, an object of the wrong kind passed by hash, an unparseable signature. |
| `REF_CONFLICT` | `Error::RefConflict` | A compare-and-swap `update_ref` (with `expected_old`) failed because the ref's current value is not the expected one — it moved, disappeared, or unexpectedly exists. The optimistic-concurrency signal. |
| `INTERNAL` | `Error::Internal` | A holo-tree internal invariant was violated. Always a holo-tree bug — report it. Exists so a violated invariant degrades to a catchable error instead of a panic (see Panic policy). |
| `PANIC` | *(binding only)* | A Rust panic was contained at the FFI boundary and converted to a JS error. Always a bug — report it. |

### Stability rules

- Codes are **append-only**. A code, once shipped, is never renamed, removed,
  or reused with a different meaning. New failure classes get new codes.
- An operation may move to a *more specific* code in a minor release (e.g. a
  failure formerly reported as `GIT` starts reporting `OBJECT_NOT_FOUND`).
  Consumers must treat `GIT` as the residual class, not an exhaustive one.
- **Message text is not part of the contract.** Messages are human-readable
  prose and may change freely. Consumers (and holo-tree's own tests) must match
  on codes, never on message substrings.
- The Rust variant's *fields* (e.g. `RefConflict.refname`) are part of the
  crate API and follow semver; the JS surface exposes only `code` + `message`.

### JS surface

Every error thrown by the binding is an `instanceof Error` with:

- `code` — one of the codes above (string).
- `message` — human-readable prose, non-contractual.

Errors raised by the binding's own marshalling (bad hex id, unknown merge mode,
invalid signature time, u16 overflow on a mode) use `INVALID_ARGUMENT`; a repo
that fails to open uses `GIT`.

## Panic policy

`holo-tree` is consumed across FFI boundaries by long-running host processes.
Per [`principles.md#never-abort-a-host-process`](../principles.md#never-abort-a-host-process),
**a panic that crosses a public entry point is a critical bug** — proven in
production when a violated `get_or_create_subtree` invariant aborted a whole
Node process (`fatal runtime error: failed to initiate panic`, gitsheets
findings #1/#6).

1. **No panicking constructs on public paths.** `.unwrap()`, `.expect()`,
   panicking indexing (`[]` on collections), and `unreachable!()` must not be
   reachable from any public crate entry point. Violated invariants return
   `Error::Internal` (code `INTERNAL`) instead. A `debug_assert!` alongside the
   graceful error is encouraged — loud in development, contained in release.
2. **Provably-infallible exceptions are eliminated, not excused.** Where a
   value is infallible by construction (a compile-time constant, a
   fixed-format render), prefer an API that cannot fail (e.g. gix's
   `ObjectId::empty_tree`) over `.expect()` with a proof comment. An
   `.expect()` may remain only when no non-panicking construction exists, with
   a comment proving why it cannot fire.
3. **The binding contains residual panics.** Every function the napi binding
   exports must convert a Rust panic into a catchable JS error carrying code
   `PANIC` — never an unwind across the `extern "C"` boundary (which aborts
   the process). This holds for release builds, and is verified by a test that
   deliberately panics through the real binding.
4. **After `INTERNAL` or `PANIC`, object state is unspecified.** The `Tree` /
   `MutableTree` involved may be inconsistent (memory-safe, but logically
   undefined); consumers should discard it and rebuild from a ref. The process
   itself must remain healthy — that is the whole point.

## Thread-safety expectations

What the library **guarantees**:

- **No correctness dependence on thread identity.** No `thread_local!` (or
  other thread-implicit) state may influence results. All caching flows
  through objects the consumer explicitly owns and passes (`TreeCache`, lent
  to operations via a `Context` that binds it to a `gix::Repository`). A host
  that dispatches successive calls of one logical operation onto different
  threads gets identical results — at worst a cold cache, never a wrong one.
- **Tree data is content-addressed, so a `TreeCache` is safe to reuse across
  trees, operations, and even repositories**: entries are keyed by tree
  `ObjectId`, and per
  [`principles.md#a-content-addressed-key-captures-exactly-what-determines-the-output`](../principles.md#a-content-addressed-key-captures-exactly-what-determines-the-output)
  the key fully determines the content. Reuse is a performance choice, never a
  correctness risk.
- Stats counters (`holo_tree::stats()`) are process-global, monotonic, and
  approximate — metrics only, never inputs to behavior.

What **hosts must uphold**:

- `MutableTree`, `TreeCache`, and `Context` are single-threaded values: they
  may be **moved** between threads (`Send`) but not **shared** concurrently
  (`!Sync` where interior mutability exists). One logical operation uses one
  of each at a time.
- A `gix::Repository` is thread-local by design; to cross threads, hold a
  `gix::ThreadSafeRepository` and derive a per-thread `Repository` (as the
  napi binding does), constructing a fresh `Context` around it per call.
- The napi binding's `Repo`/`Tree` objects may be called from whichever thread
  the JS engine dispatches on; because each `Tree` owns its cache, correctness
  never depends on which thread that is.

## Principles

**Inherited** — project principles from `principles.md` that especially bite here:

- [Never abort a host process](../principles.md#never-abort-a-host-process) —
  this spec is that principle operationalized: the code table is the "stable,
  matchable discriminants" requirement; the panic policy is the "no panics
  across public entry points" requirement.
- [Rough edges get fixed upstream, not papered over in glue](../principles.md#rough-edges-get-fixed-upstream-not-papered-over-in-glue) —
  consumers map codes onto their own typed errors; a consumer found parsing
  message prose is a signal this contract is missing a code, and the fix is a
  new code here, not a regex there.

**Local**:

- **Absence is a value, not an error.** Operations whose question is "is
  something there?" (`read_blob`, `get_child`, `resolve_ref`, `get_subtree`)
  answer absence with `None`/`null`. Errors are reserved for operations that
  could not answer their question at all. This keeps consumer probe-loops
  (does this record exist?) off the error path entirely.
