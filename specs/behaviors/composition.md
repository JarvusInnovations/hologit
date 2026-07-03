# Behavior: Composition (holobranch projection)

## Rule

Projecting a holobranch is a pure, deterministic transformation: given a root tree containing `.holo/` configuration and the resolvable source trees it references, projection produces exactly one output tree, and that tree's hash is identical across runs, engines, and platforms.

## Applies To

- `holo-projector` (`project_branch`, `project_plan`)
- `lib/Projection.js` / `lib/ProjectionPlan.js` (legacy engine, conformance oracle)
- `git holo project` and the `actions/projector/v1` GitHub Action

## Details

### Pipeline

1. **Mapping discovery** — holomappings are read from `.holo/branches/<branch>/**.toml` (each a `[holomapping]`), plus the branch's own `<branch>.toml` if present. A holobranch may `extend` another; the extends chain resolves before mapping discovery.
2. **Toposort** — mappings are ordered by their `before`/`after` constraints (including the `"*"` wildcard) using Kahn's algorithm with a `VecDeque`; unconstrained mappings retain discovery order. Ordering must be stable: the same config always yields the same order.
3. **Source resolution** — each mapping's holosource resolves in this order: self-source (the repo projecting itself) → gitlink (submodule pointer) → spec-ref (`refs/holo/source/...`) → local ref from the source's configured `ref`. Refs that point at annotated tags are peeled to commits. A `source=>holobranch` or `=>holobranch` reference triggers **recursive sub-projection**: the referenced holobranch is projected first (against the source's tree or the current tree respectively) and its output tree becomes the mapping's input.
4. **Merge** — each mapping's source tree (optionally re-rooted via `root`) merges into the output at the mapping's target path, filtered by the mapping's `files` globs. Later mappings win over earlier ones for overlapping paths (overlay semantics), subject to each merge's mode.
5. **Metadata strip** — `.holo/` is removed from the output tree.
6. **Output** — the final tree is written and its hash returned. Composition itself never writes refs or commits.

### Glob semantics

Glob matching is **minimatch-compatible**, because the legacy engine used minimatch and existing `.holo/` configs depend on its behavior:

- `**` matches **zero or more** path segments (`a/**/b` matches `a/b`). Engines built on glob libraries where `**` requires at least one segment must compensate (e.g. also matching the pattern with the `**/` prefix removed).
- Negation patterns (`!pattern`) subtract from the preceding include set; evaluation order is the config's declared order.
- A bare directory-name pattern and its `/**` expansion should behave consistently (#111 tracks a known legacy inconsistency — resolve spec-first when that work is picked up).

### Merge modes

Tree merges support three modes: **overlay** (incoming wins on conflicts), **underlay** (existing wins), **replace** (incoming replaces the subtree wholesale). Mapping composition uses overlay ordering as described above; lens output uses the mode declared by the lens config.

### Ordering and determinism

Tree children are maintained in lexicographic order (`BTreeMap`), matching git's canonical tree-entry ordering. No stage of the pipeline may iterate an unordered collection where the iteration order can affect output.

## Conformance fixtures

An engine implementation conforms when it produces hash-identical output to the reference results on:

| Repo | Holobranch | Notes |
| --- | --- | --- |
| hologit (this repo) | `docs-site` | |
| hologit (this repo) | `github-action-projector` | |
| CodeForPhilly/codeforphilly.org | `emergence-site` | ~3,000 tree writes, 9 recursive sub-projections, 50+ sources; expected hash `0dc5566ea56b34afe9de7da93d6ae3de42876d8d` |

Regression tests for known determinism/correctness hazards live in `holo-tree/tests/` (dirty-path propagation, root-node children loading, glob zero-segment matching, stable toposort).

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Determinism is the product](../principles.md#determinism-is-the-product) — the whole behavior is an instance of it; every pipeline stage must be order-stable.
- [The legacy engine is the conformance oracle](../principles.md#the-legacy-engine-is-the-conformance-oracle) — where this spec is silent, the JS engine's observable output defines correctness; capture the answer here when it matters.
- [Composition is pure](../principles.md#composition-is-pure-side-effects-live-at-the-edges) — no fetching, lensing, or ref writes inside this pipeline.
