---
status: done
depends: [holo-tree-ffi-robustness]
specs:
  - specs/architecture.md
issues: [464]
pr: 491
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

- [x] `specs/architecture.md` updated with the binding's declared role
- [x] #464 either executed (benchmarked improvement recorded) or closed with rationale
- [x] npm package README states its support posture

## Risks / unknowns

- Unknown external npm consumers (the package is public); check download stats before freezing.

## Notes

- **Decision: supported standalone npm primitive** (maintainer call — multiple npm consumers planned on it). Both consumption modes (Cargo git-tag pins, npm binding) are first-class surfaces of the same crate; recorded in `specs/architecture.md` § Embedding consumers / § Release tracks, with pre-1.0 semver posture. The freeze branch of the Approach was not taken, so the download-stats check was moot.
- **#464 re-audit against post-#490 reality**: items 1 (per-call `to_thread_local()`) and 2 (gix object cache off) were still open and got executed — memoized thread-id-keyed repo derivation per `Repo`/`Tree` + 16 MiB `object_cache_size_if_unset`; item 3 (`cache_read` vec clone) turned out resolved-by-design after #490 (one clone per node per Tree lifetime, immediately consumed); item 4 became README warning + `buildProfile()` guard + bench refusing debug builds.
- Item 2 depends on item 1: with per-call derivation the object cache was always cold — enabling it alone would have been a no-op. The dependency this plan declared on the cache redesign paid off the same way.
- Headline numbers (18k-record reference workload, release, min-of-20): warm-tree `readBlob` ×200 11.2ms → 0.69ms (16×); batch-500 upsert −12%; bulk load −19%; full table in PR #491 and the #464 comment. Fresh debug-build measurements (~7–15× slower than release) re-confirmed the spike's warning with current code.
- The soundness rule for the memoization (thread-id-keyed reuse; a handle never *used* off its deriving thread) was added to `specs/api/errors.md` § Thread-safety expectations *before* the code change — it generalizes to any future binding (pyo3).
- Incidental: `node --test test/` (trailing-slash dir form) broke on newer Node 22.x; `npm test` now passes an explicit glob.
- Publication of all of this rides the next `holo-tree-v*` tag, deferred with the release train.

## Follow-ups

- Tracked as: `holo-tree-v*` release tag for the improved binding — deferred with the release train; cut per `holo-tree-napi/README.md` § Releases when trains resume.
