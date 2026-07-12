---
status: in-progress
depends: []
specs:
  - specs/behaviors/composition.md
issues: [436]
---

# Remote source fetching (Rust engine)

## Scope

Let the Rust engine resolve sources that aren't local yet. The JS engine runs `git fetch --depth=1` per source URL/ref, storing results under `refs/holo/source/{spec_hash}/{ref_suffix}`; today the Rust engine errors ("no gitlink found and ref resolution failed") when a source is unfetched. Options: gix native fetch, or shelling out to `git fetch` as an interim.

## Implements

- **First step:** add a `specs/behaviors/source-resolution.md` spec covering fetch semantics: the `refs/holo/source/...` ref layout, depth/tags policy, refresh rules (`git holo source fetch`), and concurrency requirements.
- Extends the source-resolution order in `specs/behaviors/composition.md` (fetch is the edge capability that populates spec-refs; resolution itself stays pure).

## Approach

1. Spec current JS fetch behavior, and fold in the lessons from #450 (the shallow-clone race under concurrent per-source fetches — the fixed behavior is the specced behavior: concurrent fetches must not corrupt or race the shallow file).
2. Prefer gix-native fetch for embeddability (no `git` binary dependency inside library consumers); fall back to subprocess only if gix's shallow-fetch support proves insufficient.
3. Keep fetch outside the composition core: a resolve-or-fetch layer that populates `refs/holo/source/...`, invoked by the CLI/binding before or during projection.

## Validation

- [ ] `specs/behaviors/source-resolution.md` accepted and merged
- [ ] A projection whose sources are entirely unfetched completes end-to-end via the Rust path and produces the reference hash
- [ ] Concurrent multi-source fetch (~15 sources) is race-free under repetition (regression guard for the #450 class)
- [ ] Ref layout under `refs/holo/source/...` is byte-compatible with the JS engine's (interoperable caches)

## Risks / unknowns

- gix shallow-fetch maturity across transports (https, ssh) — may force the subprocess interim.
- Auth (credential helpers, ssh agents) is free with subprocess `git`, real work with gix.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
