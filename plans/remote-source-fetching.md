---
status: done
depends: []
specs:
  - specs/behaviors/composition.md
  - specs/behaviors/source-resolution.md
issues: [436]
pr: 496
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

- [x] `specs/behaviors/source-resolution.md` accepted and merged
- [x] A projection whose sources are entirely unfetched completes end-to-end via the Rust path and produces the reference hash
- [x] Concurrent multi-source fetch (~15 sources) is race-free under repetition (regression guard for the #450 class)
- [x] Ref layout under `refs/holo/source/...` is byte-compatible with the JS engine's (interoperable caches)

## Risks / unknowns

- gix shallow-fetch maturity across transports (https, ssh) — may force the subprocess interim.
- Auth (credential helpers, ssh agents) is free with subprocess `git`, real work with gix.

## Notes

- **gix 0.83 was probed empirically before choosing the transport** (per Approach #2): shallow depth-1
  fetch works over https and ssh with the holo refspec layout and stores annotated-tag refs unpeeled —
  but https needs an explicit TLS transport feature (`blocking-http-transport-reqwest-rust-tls`; the
  base reqwest/curl features fail at runtime), default tag-following writes `refs/tags/*` where
  `--no-tags` would not, ssh spawns the system `ssh` anyway, credential-helper auth shells out to
  `git credential`, and the reqwest/rustls tree is heavy. Subprocess `git fetch` shipped as the
  spec's **declared interim transport**; full findings live in the spec's Status table.
- On concurrency, gix fails fast on `shallow.lock` instead of corrupting — same #450 symptom class,
  so per-git-dir serialization is required under either transport. The regression guard was
  negative-controlled: with the lock disabled, the 15-source stress test fails immediately with
  `Unable to create shallow.lock`.
- Two latent oracle divergences surfaced and were fixed en route: url-bearing sources fell through
  to same-named **local refs** (JS only consults local refs for url-less sources), and bare-hash
  source refs (codeforphilly.org pins `google/recaptcha` to a commit) need the JS engine's uniform
  `ref.substr(5)` spec-ref suffix or the caches aren't interoperable.
- End-to-end evidence: fresh codeforphilly.org clone @ `c491905a` with zero `refs/holo/*` refs →
  Rust `--fetch` and JS-from-zero produce byte-identical 72-ref layouts and the same
  `emergence-site` hash (`de630914…`).

## Follow-ups

- Tracked as: gix-native fetch transport remains the desired state — recorded (with probe results)
  in `specs/behaviors/source-resolution.md` § Status; revisit when embeddability demands it.
- Tracked as: exposing `*_fetching` through holo-projector-napi and removing the hybrid CLI's
  "fetch requested" JS fallback (`lib/RustEngine.js`, `specs/behaviors/engine-selection.md`) is
  binding/dispatch work outside this plan's file domain — noted in PR #496 for whoever picks up
  the engine-selection seam next.
