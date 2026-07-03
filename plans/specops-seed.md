---
status: in-progress
depends: []
specs:
  - specs/README.md
  - specs/principles.md
  - specs/architecture.md
  - specs/behaviors/composition.md
issues: []
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
- [ ] PR merged to develop

## Risks / unknowns

- Seeded plans were authored from survey knowledge, not fresh deep-dives; scopes/approaches may shift when each is picked up — that's expected and cheap to amend while `planned`.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
