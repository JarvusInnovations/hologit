# Claude Code Guidelines

## Project overview

Hologit is a git-native framework for declarative code composition. The `project` command is the core operation: it reads `.holo/` config from a git tree, resolves sources, merges trees according to mappings, and outputs a composed tree hash.

The project is migrating its performance-critical core from Node.js to Rust:

- **`holo-tree/`** — Shared crate: mutable git tree primitives (merge, write, glob, cache) via gix. Also used by gitsheets.
- **`holo-projector/`** — Projection crate: holobranch config, source resolution, composition. Depends on holo-tree.
- **`holo-tree-napi/`** — napi-rs binding exposing holo-tree to Node.js; published to npm as `@hologit/holo-tree` (the package gitsheets consumes). See its [`README.md`](../holo-tree-napi/README.md).
- **`holo-projector-napi/`** — napi-rs binding exposing holo-projector to the CLI (unpublished; loaded from the in-repo build via `npm run build:projector-addon`). See its [`README.md`](../holo-projector-napi/README.md).
- **`lib/`** — Existing Node.js implementation (still the CLI entry point). The CLI is a **hybrid**: pure composition delegates to the Rust engine when the projection shape allows (`specs/behaviors/engine-selection.md`), with observable fallback to the JS engine; `HOLO_ENGINE=js|rust` forces either path.

The four Rust crates form a Cargo workspace defined in the root `Cargo.toml`.

## Spec-driven development (specops)

This project uses spec-driven development. `specs/` is the source of truth for what
*should be true*; `plans/` is the work-in-flight DAG that bridges specs to merged code.
The **specops** skill carries the full methodology — invoke it (the skill triggers on
"spec", "plan", starting a feature, etc.) before writing specs, planning, or building.

- **Specs lead.** Before changing behavior, change the spec; bring code into conformance
  after. Spec↔code drift is a bug, not debt. Backfill policy for this mature codebase:
  spec-on-contact (see `specs/README.md`) — don't retro-spec areas no work touches.
- **`plans/` is the planning system — not your built-in plan mode.** Every chunk of work
  lands as a file in `plans/` that freezes to `done` as the durable record of what got
  built. Don't let an ephemeral plan substitute for it, and don't skip it for "small"
  changes. (Classic trap: an ad-hoc plan of "write spec X, then build it" that ends with
  neither a reviewed spec nor a plan file — split those into the two real artifacts.)
- **When to author a plan depends on intent:** mapping out a batch of specs → finish the
  batch first, then propose a *set* of plans; speccing one bounded feature in a mature
  project → draft the spec change and its plan in tandem; intent unclear → ask. The skill
  details each mode.
- **A spec change ripples to its plans.** After editing a spec, review the plans that
  implement it (`grep -l '<spec-path>' plans/*.md`) and offer to update them.

Query the DAG: `.claude/skills/specops/scripts/specops next` (what to work on next) and
`.claude/skills/specops/scripts/specops dag` (graph).

## Releases

Two independent npm packages ship from this repo on **separate, prefix-namespaced
git-tag tracks** — keep them distinct:

- **`hologit`** (the Node.js CLI/library) — released on **`v*`** tags via the
  develop→master Release-PR flow (`release-prepare`/`-validate`/`-publish`
  workflows; the `release-flow` skill). Pushing `develop` opens a `Release: v*`
  PR into `master`; merging it publishes.
- **`@hologit/holo-tree`** (the napi binding) — released on **`holo-tree-v*`**
  tags. Pushing e.g. `holo-tree-v0.1.2` triggers
  `.github/workflows/holo-tree-napi.yml`, which builds the three platform
  prebuilds natively (linux-x64-gnu, darwin-arm64, win32-x64-msvc) and publishes
  via npm **trusted publishing** (OIDC, tokenless). The git tag is the release
  marker; `napi prepublish` runs with `--skip-gh-release`.

**Never tag the binding with a bare `v*`** — it collides with the `hologit` JS
release namespace and matches `publish-npm.yml`'s `v*` trigger. Full binding
release + one-time-bootstrap details: [`holo-tree-napi/README.md`](../holo-tree-napi/README.md).

## Development workflow

### Branches and PRs

- Create a new branch off of `origin/develop` after fetching
- Push branch and create a PR against `develop`

### Node.js tests

- Manually verify that `test-cli` tests defined in `.github/workflows/pr-test.yml` work

### Rust development

The Cargo workspace is at the repo root. Use `asdf` for the Rust toolchain (version in `.tool-versions`).

```sh
# Run all tests across the workspace
cargo test

# Run tests for one crate
cargo test -p holo-tree
cargo test -p holo-projector

# Build the benchmark CLI
cargo build --release -p holo-projector --features cli

# Build the CLI's projector addon (release) and run its node --test suite
npm run build:projector-addon
npm --prefix holo-projector-napi test
```

### Benchmarking

The primary benchmark target is [CodeForPhilly/codeforphilly.org](https://github.com/CodeForPhilly/codeforphilly.org) with the `emergence-site` holobranch — a complex projection with ~3,000 tree writes and 9 recursive sub-projections. Clone it locally to run benchmarks.

**Rust benchmark:**

```sh
./target/release/holo-project --repo /path/to/codeforphilly.org --ref HEAD --stats emergence-site
```

**JS baseline (for comparison):**

```sh
cd /path/to/codeforphilly.org
node -e "
const start = Date.now();
const h = require('/path/to/hologit');
(async () => {
    const r = await h.Repo.getFromEnvironment({ ref: 'HEAD' });
    const ws = await r.createWorkspaceFromRef(r.ref);
    const hash = await h.Projection.projectBranch(ws.getBranch('emergence-site'), { lens: false });
    console.log(hash);
    console.error('JS: ' + (Date.now() - start) + 'ms');
})().catch(e => { console.error(e); process.exit(1); });
"
```

**Hash verification:** the invariant is that the Rust and JS engines produce **identical hashes on the same commit** — upstream HEAD moves, so compare engine-vs-engine rather than against a pinned hash. (Historical anchor: `0dc5566ea56b34afe9de7da93d6ae3de42876d8d` at the commit used during the Rust-engine port.) Also verify `docs-site` and `github-action-projector` on the hologit repo itself.

### Correctness invariants

When modifying the Rust engine, always verify:

1. `cargo test` — all unit and integration tests pass
2. Hash-identical output for `docs-site`, `github-action-projector` (hologit repo), and `emergence-site` (codeforphilly.org)
3. No performance regression on emergence-site (expect ~27ms warm, ~100ms cold)

### Key gotchas (from PoC debugging)

These are correctness issues that caused hash mismatches during development. Each has a dedicated regression test:

- **`get_or_create_subtree` postconditions** — two separate bugs, both with regression tests in `holo-tree/tests/write_child.rs`: (a) mark the *whole* navigated path dirty (root included), not just newly-created nodes, or a write into an already-existing dir is silently lost during `write()`; (b) the returned node must have its children loaded — **including the `path == "."` root case** — or a mutating caller (`write_child_bytes`, e.g. a repo-root file like `a.toml`) hits `children.as_mut().unwrap()` on `None`, which **aborts the host process across the napi FFI boundary**. Cover both deep and root-level paths when testing.
- **Glob `**` zero-segment matching** — globset's `**` doesn't match zero path segments unlike minimatch. Fix: add suffix pattern without `**/` prefix
- **BTreeMap for children** — HashMap's random iteration order causes different merge results for unconstrained mappings
- **Tag peeling** — source refs may point to annotated tags, not commits directly
- **Stable toposort** — Kahn's algorithm with VecDeque preserves discovery order for unconstrained nodes
