# Architecture

Hologit is a git-native framework for declarative code composition. Its core operation, **projection**, reads `.holo/` configuration from a git tree, resolves sources, merges trees according to mappings, optionally transforms the result through lenses, and outputs a composed tree (and optionally a commit on a target ref).

## Two engines, one behavior

The project is mid-migration from a Node.js engine to a Rust core. Both engines must produce hash-identical output (see [principles.md — the legacy engine is the conformance oracle](principles.md#the-legacy-engine-is-the-conformance-oracle)).

| Component | Language | Role |
| --- | --- | --- |
| `lib/` + `commands/` + `bin/cli.js` | Node.js (CJS) | The shipping CLI (`git holo`). Sole owner of lensing, remote source fetching, watch mode, projection commits, and the studio. |
| `holo-tree/` | Rust | Shared mutable git-tree primitives over gix: merge (overlay/replace/underlay), glob, blob/commit/ref ops, tree cache. Consumed by holo-projector and, as a Cargo git-tag dependency, by gitsheets-core. |
| `holo-projector/` | Rust | The projection engine: `.holo/` config parsing, source resolution, mapping toposort, recursive sub-projection, composition. Pure — no network, containers, or ref writes. Benchmark CLI behind the `cli` feature. |
| `holo-tree-napi/` | Rust (napi-rs) | Node binding over holo-tree only (tree/ref/blob CRUD), published to npm as `@hologit/holo-tree` — a supported standalone primitive for Node consumers (see Embedding consumers). Does **not** expose projection. |

The three Rust crates form a Cargo workspace at the repo root.

## Migration strategy

The migration proceeds capability-by-capability, pure core outward (see [principles.md — composition is pure](principles.md#composition-is-pure-side-effects-live-at-the-edges)):

1. **Done:** tree primitives (holo-tree) and pure composition (holo-projector), validated hash-identical and ~130x faster warm on the reference projections.
2. **Next:** wire the Rust projector into the Node CLI via a `holo-projector-napi` binding (#434). The interim CLI is a **hybrid**: JS handles side effects (fetching, lensing, commits, watch), delegating pure composition to Rust.
3. **Then:** port the side-effecting edges — projection commits (#438), remote fetching (#436), lens execution (#435), watch mode (#437) — each spec-first, since these are the areas where desired state may deliberately diverge from current JS behavior (notably the lens runtime).
4. **End state:** the JS engine retires; the CLI becomes a thin shell over the Rust engine.

## Embedding consumers

holo-tree is a substrate for external git-backed systems, consumed in **two first-class modes** — both are supported surfaces of the same crate, neither is a stepping-stone for the other:

- **Cargo git-dependency** — Rust consumers pin holo-tree directly via `holo-tree-v*` git tags. The reference consumer is **gitsheets** (`gitsheets-core`).
- **npm `@hologit/holo-tree`** — the napi binding, a **supported standalone primitive** for Node consumers: git tree/ref/blob/commit operations on bare or normal repos with no `git` binary. It began as gitsheets' integration vehicle; it now stands on its own as the substrate for Node-side git-backed systems, with its own support posture, performance story, and optimization backlog (#464).

Both modes implement the same contract:

- The **error contract** in [api/errors.md](api/errors.md): stable machine-matchable codes (append-only), panic containment at the FFI boundary, and the thread-safety guarantees consumers rely on.
- The FFI robustness requirements in [principles.md — never abort a host process](principles.md#never-abort-a-host-process): no panics on public paths, structured error discriminants, and no reliance on thread-implicit state under host-controlled thread dispatch (napi/libuv, pyo3).

**Semver posture (npm binding)**: while the package is pre-1.0, breaking changes to the JS surface (removed/renamed methods, changed shapes) bump the minor version; additive changes and fixes bump the patch. Error codes are append-only regardless of version, per the stability rules in [api/errors.md](api/errors.md). The binding must ship as a release build — a debug build inverts its performance advantage (documented prominently in `holo-tree-napi/README.md`).

## Release tracks

Two independent npm packages ship from this repo on prefix-namespaced git-tag tracks:

- **`hologit`** (Node CLI/library) — `v*` tags via the develop→master Release-PR flow.
- **`@hologit/holo-tree`** (napi binding) — `holo-tree-v*` tags. One tag serves **both** consumption modes: it triggers the npm publish (platform prebuilds + trusted publishing) *and* is the Cargo git-dependency pin Rust consumers reference. Never tag the binding with a bare `v*`.

The `actions/projector/v1` ref publishes the GitHub Action consumers use to project holobranches in CI.

## Principles

**Inherited** — all of `principles.md` applies; the ones that shape architecture decisions most directly:

- [Determinism is the product](principles.md#determinism-is-the-product) — engine equivalence is defined by output hash, which is what makes a two-engine transition safe at all.
- [Composition is pure; side effects live at the edges](principles.md#composition-is-pure-side-effects-live-at-the-edges) — defines the migration seam and the crate boundaries.
- [Rough edges get fixed upstream](principles.md#rough-edges-get-fixed-upstream-not-papered-over-in-glue) — bindings stay thin; core crates absorb the fixes.
