# API: holo-projector-napi binding

The Node.js surface of the Rust projection engine: the entry points the CLI's
hybrid dispatcher calls (see `specs/behaviors/engine-selection.md`), and the
error contract they extend from `specs/api/errors.md`.

## Applies to

- The `holo-projector-napi` crate (npm name `@hologit/holo-projector`;
  publication is deferred — the CLI loads it from the in-repo build).
- `lib/RustEngine.js`, the only in-repo consumer.

## Surface

All functions are synchronous, take `gitDir` (a `.git` directory or any path
gix can discover a repo from), and exchange object ids as lowercase hex
strings. `rootTree` accepts a tree hash, or a commit/tag hash which is peeled
to its tree.

| Export | Returns | Semantics |
| --- | --- | --- |
| `compositeBranch(gitDir, rootTree, holobranch)` | tree hash | The **pre-lens composed tree**: the extends chain and all mappings composed per `specs/behaviors/composition.md`, with `.holo/{branches,sources}` stripped but the final `.holo` strip **skipped** (`.holo/config.toml` and `.holo/lenses` are retained for the JS lens phase). |
| `projectBranch(gitDir, rootTree, holobranch)` | tree hash | Full composition-only projection, including the final metadata strip. Hash-equal to the oracle with lensing disabled. |
| `projectPlan(gitDir, sources, mappings)` | tree hash | Structured-config composition (the `ProjectionPlan` path); no `.holo/` config needed. `sources`: `{ name, url?, ref?, projectHolobranch? }`. `mappings`: `{ source, files?, root?, output?, layer?, after?, before? }` with the same defaults as `ProjectionPlan.addMapping`. |
| `stats()` | `{ treesRead, treesWritten, treesSkippedClean, cacheHits, cacheMisses, blobsRead }` | Process-global monotonic counters (metrics only). |
| `resetStats()` | — | Reset counters and module caches. |
| `__triggerPanicForTest()` | throws `PANIC` | Test hook proving panic containment; never call outside tests. |

## Error contract

Inherits `specs/api/errors.md` wholesale: every failure is a catchable JS
`Error` with a stable `code` property; panics are contained per the panic
policy (per-export `catch_unwind` plus a `contained()` wrapper) and surface as
code `PANIC`; message text is never contractual; codes are append-only.

Codes added by `holo_projector::Error` (surfaced via `Error::code()`):

| Code | Rust variant | Raised when |
| --- | --- | --- |
| `CONFIG` | `Error::Config` | A `.holo/` TOML file is malformed or semantically invalid (e.g. a holomapping with no `files`). |
| `SOURCE_RESOLUTION` | `Error::SourceResolution` | A holosource resolved to no commit via gitlink → spec-ref → local ref (`specs/behaviors/source-resolution.md`). Without a fetcher this is the dispatcher's cue that the source may simply be unfetched; the crate's `*_fetching` entry points fetch on demand instead. |
| `SOURCE_FETCH` | `Error::SourceFetch` | A remote source fetch failed (network, auth, unknown remote ref, non-zero git exit). Distinct from `SOURCE_RESOLUTION` per `specs/behaviors/source-resolution.md` § Errors. |
| `CIRCULAR_DEPENDENCY` | `Error::CircularDependency` | Mapping `before`/`after` constraints form a cycle. |
| `LENSED_SUBPROJECTION` | `Error::LensedSubprojection` | A recursive sub-projection would lens under the oracle's semantics (see `specs/behaviors/composition.md` § Sub-projection lensing). The composition-only engine refuses rather than silently skipping the lens. |
| `PROJECTION` | `Error::Other` | Residual projection failure not classified above. |

`Error::Tree` forwards the underlying `holo_tree::Error` code unchanged
(`GIT`, `OBJECT_NOT_FOUND`, `NOT_A_TREE`, …). Binding-level marshalling
failures use `INVALID_ARGUMENT` (bad hex id) and `GIT` (repo failed to open),
matching the holo-tree binding.

## Notes

- **Packaging**: mirrors `holo-tree-napi` conventions (napi-rs v2, committed
  generated `index.js`/`index.d.ts`, platform triples declared) but ships no
  platform packages yet — publication is a follow-up. When it happens, the
  release tag track is prefix-namespaced (`holo-projector-v*`); a bare `v*`
  tag is never acceptable (it collides with the `hologit` release namespace).
- The binding opens the repository per call; callers batch work per
  projection, and tree caching lives inside the engine for the duration of a
  call.

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Never abort a host process](../principles.md#never-abort-a-host-process) —
  same operationalization as the holo-tree binding: stable codes, contained
  panics, verified by a deliberate-panic test.
- [Rough edges get fixed upstream, not papered over in glue](../principles.md#rough-edges-get-fixed-upstream-not-papered-over-in-glue) —
  the dispatcher branches on codes (`SOURCE_RESOLUTION`,
  `LENSED_SUBPROJECTION`), never message prose; a missing discriminant is
  fixed by adding a code here.
