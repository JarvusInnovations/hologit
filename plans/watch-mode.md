---
status: done
depends: [projector-napi-cli, projection-commits]
specs:
  - specs/behaviors/watch.md
  - specs/behaviors/composition.md
  - specs/behaviors/engine-selection.md
  - specs/behaviors/projection-commits.md
  - specs/api/projector-napi.md
issues: [437]
pr: 499
---

# Watch mode for continuous projection (Rust engine)

## Scope

Continuous re-projection on change: monitor the working tree and/or git refs and re-run projection (and optionally commit/advance refs) on each change. This is where the Rust engine's ~27ms warm projections become a product capability — live local composition that the 3.5s JS engine could never make feel instant.

## Implements

- **First step:** author `specs/behaviors/watch.md` — watch triggers (working tree vs refs), debounce, re-projection scope, output/commit behavior per cycle, and supersession (a newer change cancels an in-flight projection — subsumes the intent of #19 for the lens era).

## Approach

1. Spec from `commands/watch.js` behavior (watchman for working tree, chokidar for refs), then decide the Rust shape: `notify` crate + gix ref monitoring, or a callback/event boundary where the host (CLI or embedding consumer) owns watching and triggers re-projection.
2. Prefer the event-boundary design: it keeps the engine pure (per principles) and gives embedding consumers (gitsheets watch mode is its own tracked want, gitsheets#135) the same primitive.
3. Depends on projector-napi-cli (delegation path exists) and projection-commits (watch cycles that commit).
   Wire the engine's `commit_projection` through the napi binding and the CLI's commit path (deferred from [`projection-commits`](projection-commits.md)): expose it as a binding export per `specs/api/projector-napi.md` conventions, and have the hybrid dispatcher use it — the host supplies the `git describe --always --tags` string and identity, per `specs/behaviors/projection-commits.md` (provenance is host-supplied).
4. Warm engine context across binding calls (deferred from [`projector-napi-cli`](projector-napi-cli.md)): the napi binding currently opens the repo and builds a fresh `TreeCache` per call (~130ms/composition on emergence-site). Hold a persistent handle + cache across watch cycles via holo-projector's `*_in` Context variants — designing for the staleness hazards (refs and packs written between projections) — to reach the warm target. Consider holo-tree-napi's thread-id-memoized `local_repo` pattern (PR #491) for the handle.
5. For lensed holobranches, watch-cycle latency depends on the warm lens-container pool from `specs/behaviors/lensing.md` (Container lifecycle): one container per image digest held for the session, jobs multiplexed over per-job refs, incremental object transfer to warm containers. Watch mode is that design's primary beneficiary — without it, container churn dwarfs the ~27ms composition budget. Not a hard dependency (unlensed branches watch fine; hybrid can lens via JS), but full-speed lensed watch requires lens-execution.

## Validation

- [x] `specs/behaviors/watch.md` accepted and merged (same PR, with amendments to `engine-selection.md`, `projector-napi.md`, `projection-commits.md`)
- [x] Edit → re-projection latency on emergence-site-scale workspace is sub-100ms warm (~90ms commit→publication e2e for output-changing edits; 62–82ms in-process warm projection)
- [x] Repeat projections reuse a warm engine context (persistent repo handle + `TreeCache` across binding calls; deferred from [`projector-napi-cli`](projector-napi-cli.md)) — first call 123–195ms vs 62–82ms warm; warm cycles do 0 tree reads (3,380 cache hits); binding tests prove cache reuse via `cachedTrees()`/stats
- [x] Rapid successive changes coalesce (debounce) and stale in-flight projections are superseded (burst of 5 commits → 2 publications, final matches one-shot of final state; `WatchLoop` unit tests + `project --watch` child-process integration tests)
- [x] `--working` projections reflect uncommitted changes correctly (emergence-site with an uncommitted mapped file: `2e36d5fe…` both engines, change present in output)
- [x] Watch cycles that commit do so through the Rust `commit_projection` path via the binding, hash-identical to the JS commit path (deferred from [`projection-commits`](projection-commits.md)) — `docs-site --commit-to` under pinned identity: `4ceee3a4…` byte-identical from both engines; CI dual-engine gate extended with the commit-parity step; dispatch is `HOLO_ENGINE=rust`-gated (JS remains the default committer per `engine-selection.md` § Commit dispatch)

## Risks / unknowns

- Working-tree hashing cost may dominate the 27ms projection at scale; may need incremental tree hashing.
- Watchman dependency: keep, or replace with `notify` for zero external deps? Spec decision.

## Notes

- **Event-boundary design confirmed**: the engine gained no watch dependency; the host owns watching and triggers re-projection through a warm `ProjectionSession` (explicit consumer-owned object per the post-#490 philosophy; thread-id-memoized handle per holo-tree-napi's `local_repo`). Watchman (working tree) and chokidar (refs) both stay.
- **Staleness contract proven, not assumed**: only content-addressed state is cached across calls; refs re-resolve every call and externally written objects are visible — binding tests advance a source spec-ref and write commits behind an open session via the git CLI and assert the next call observes them. gix's stat-revalidated packed-refs snapshot and refresh-on-miss ODB behave as required.
- **Two real inotify failure modes found and specced** (`watch.md` § Triggers): a file-level watch dies permanently at the first rename-over of a ref, and even a directory-level watch can coalesce a burst into one event delivered *before* the final state. Implementation: directory-level events (fast path) + per-ref `fs.watchFile` stat poll (500ms safety net); coalescing is harmless because the handler reads the ref's current value at processing time.
- **Watch startup race fixed**: the watcher subscribes before the initial projection, which runs through the same latest-wins loop — previously an edit landing between the first output and subscription was silently lost.
- **Unlensed fast path**: with lensing disabled the CLI uses the binding's full `projectBranch` (spec'd hash-equal with lensing disabled), skipping all JS tree operations per cycle — this took the e2e cycle from ~150ms to ~90ms. Working-tree eligibility was refined in `engine-selection.md`: only checked-out source sub-worktrees under `.holo/sources/` force the JS engine.
- **Working-tree hashing did not dominate** at emergence-site scale (~40–50ms warm via the holoindex `git reset`/`add`/`write-tree` sequence vs ~80ms projection); incremental hashing not needed yet — revisit only if larger workspaces change the balance.
- The historical ~27ms warm figure is machine-dependent; on this box the warm engine cycle is 62–82ms, ~60ms of which is re-hashing/re-writing all 3,057 output trees every cycle (0 reads, `treesSkippedClean=0`) — see follow-up #498.
- Rebased over [`remote-source-fetching`](remote-source-fetching.md) (PR #496): `*_in` signatures were unchanged (separate `*_fetching_in` variants), `SOURCE_FETCH` flows through the binding's generic code mapping, and the session test fixture moved from local-ref to spec-ref resolution when #496 removed the local-ref fallback.

## Follow-ups

- Issue [#497](https://github.com/JarvusInnovations/hologit/issues/497) — wire source fetching through the projector binding (lift the `fetch requested` fallback; engine capability landed with #496; watch's `--fetch` startup cycle falls back to JS until then)
- Issue [#498](https://github.com/JarvusInnovations/hologit/issues/498) — avoid redundant tree writes on warm projection cycles (~60ms of the ~80ms emergence-site warm cycle)
- Tracked as: warm lens-container pool for lensed watch cycles is [`lens-execution`](lens-execution.md)'s scope (in progress — not edited here per plan protocol); lensed branches meanwhile watch via the hybrid path (Rust composite → JS lens per cycle), seam at `Projection.projectBranch`'s lens branch
