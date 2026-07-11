# Specs

This directory declares the **desired state** of hologit. Specs lead; implementation follows. Code without a corresponding spec is unspecified behavior; spec without code is a known gap tracked in `plans/`.

Hologit adopted spec-driven development (the **specops** skill, vendored at `.claude/skills/specops/`) mid-life, as a mature codebase. Specs are therefore **backfilled on contact**, not exhaustively:

- Foundational specs (`architecture.md`, `principles.md`) and the composition behavior spec were seeded up front because the material already existed in validated form.
- Everything else gets specced **when work touches it** — the first step of a plan that changes an area is settling that area's spec. Mature code with no spec isn't a violation; it's behavior nobody has needed to pin down yet.
- The legacy Node.js engine (`lib/`) is generally *not* specced retroactively. During the Rust migration it serves as the conformance oracle (see `principles.md`); its behavior gets captured into specs as each capability is ported.

## Layout

```
specs/
├── README.md              # This file
├── principles.md          # Project-wide decisive principles
├── architecture.md        # Crates, engines, bindings, release tracks, migration strategy
├── api/                   # Library/binding contracts
│   └── errors.md          # holo-tree error codes, panic policy, thread-safety expectations
└── behaviors/             # Cross-cutting rules
    └── composition.md     # Projection/composition semantics (the core operation)
```

Expected to grow as work touches each area (spec-on-contact):

- `behaviors/lensing.md` — lens execution model (write before porting lensing to Rust)
- `behaviors/source-resolution.md` — if source semantics grow beyond what `composition.md` covers
- `api/` — napi binding surfaces as they stabilize

## Workflow

1. **Spec change** — propose what should be true
2. **Accept** — review agrees on desired state
3. **Implement** — bring code into conformance (tracked as a plan in `plans/`)
4. **Verify** — compare running software to spec

When a spec changes, review the plans that implement it: `grep -l '<spec-path>' plans/*.md`.

## Conventions

- Specs declare **what** must be true, not **how** to implement it.
- Behavior specs must be testable — two implementers reading one should never disagree about whether code conforms.
- Each spec may carry a `## Principles` section: **Inherited** entries reference `principles.md` anchors that especially bite there; **Local** entries hold principles owned by that spec (promote to `principles.md` when one spreads to a second spec).
