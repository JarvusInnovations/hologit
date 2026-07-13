---
status: done
depends: []
specs:
  - specs/README.md
  - specs/principles.md
  - specs/architecture.md
  - specs/behaviors/composition.md
issues: []
pr: 481
---

# Seed spec-driven development (specops) in hologit

## Scope

Bootstrap the specops methodology in this mature codebase: vendor-installed skill (already committed), foundational specs, the plans DAG seeded from the Rust-migration roadmap, the CLAUDE.md hook, and the session dashboard hook. Deliberately **not** a wholesale spec backfill — the policy is spec-on-contact (see `specs/README.md`).

## Implements

- `specs/README.md`, `specs/principles.md`, `specs/architecture.md`, `specs/behaviors/composition.md` (all authored by this plan)

## Approach

1. Foundational trio: README (layout + backfill policy), principles (promoted from CLAUDE.md gotchas, the gitsheets spike protocol, and the migration's implicit rules), architecture (two engines, migration strategy, release tracks).
2. One nearly-free behavior spec: composition, transcribed from the validated Rust port + JS oracle.
3. Plans DAG from GitHub issues #434–#438 + FFI-robustness findings + the napi-binding direction decision.
4. CLAUDE.md hook block + `specops hook install` for the session dashboard.

## Validation

- [x] `specs/` foundations exist and cross-link correctly
- [x] `plans/` DAG resolves: `specops next` runs clean with no hygiene warnings
- [x] CLAUDE.md carries the specops hook block
- [x] SessionStart dashboard hook installed
- [x] PR opened against develop (#481; merging it completes the closeout)

## Risks / unknowns

- Seeded plans were authored from survey knowledge, not fresh deep-dives; scopes/approaches may shift when each is picked up — that's expected and cheap to amend while `planned`.

## Notes

- Seeded as a targeted foundation, not a wholesale backfill — the spec-on-contact policy in `specs/README.md` governs future backfill.
- Plan scopes drew on a seven-repo consumer survey (cfp-live-cluster, wmata-tides-infra, b21-skeleton, godrive, codeforphilly-ng, jarvus-infra-ops, gitsheets) conducted in the same session.

## Follow-ups

- Deferred to plan: each side-effecting capability's behavior spec (`lensing.md`, `source-resolution.md`, `watch.md`, `projection-commits.md`, `api/errors.md`) is the first step of its respective seeded plan.
- None otherwise.
