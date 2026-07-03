---
status: planned
depends: [projector-napi-cli, projection-commits]
specs:
  - specs/behaviors/composition.md
issues: [437]
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

## Validation

- [ ] `specs/behaviors/watch.md` accepted and merged
- [ ] Edit → re-projection latency on emergence-site-scale workspace is sub-100ms warm
- [ ] Rapid successive changes coalesce (debounce) and stale in-flight projections are superseded
- [ ] `--working` projections reflect uncommitted changes correctly (watch is the main consumer of working-tree trees)

## Risks / unknowns

- Working-tree hashing cost may dominate the 27ms projection at scale; may need incremental tree hashing.
- Watchman dependency: keep, or replace with `notify` for zero external deps? Spec decision.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
