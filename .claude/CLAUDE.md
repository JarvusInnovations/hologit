# Claude Code Guidelines

## Project overview

Hologit is a git-native framework for declarative code composition. The `project` command is the core operation: it reads `.holo/` config from a git tree, resolves sources, merges trees according to mappings, and outputs a composed tree hash.

The project is migrating its performance-critical core from Node.js to Rust:

- **`holo-tree/`** — Shared crate: mutable git tree primitives (merge, write, glob, cache) via gix. Also used by gitsheets.
- **`holo-projector/`** — Projection crate: holobranch config, source resolution, composition. Depends on holo-tree.
- **`holo-tree-napi/`** — napi-rs binding exposing holo-tree to Node.js; published to npm as `@hologit/holo-tree` (the package gitsheets consumes). See its [`README.md`](../holo-tree-napi/README.md).
- **`lib/`** — Existing Node.js implementation (still the CLI entry point).

The three Rust crates form a Cargo workspace defined in the root `Cargo.toml`.

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
# Run all tests across both crates
cargo test

# Run tests for one crate
cargo test -p holo-tree
cargo test -p holo-projector

# Build the benchmark CLI
cargo build --release -p holo-projector --features cli
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

**Hash verification:** Both must produce `0dc5566ea56b34afe9de7da93d6ae3de42876d8d` for emergence-site. Also verify `docs-site` and `github-action-projector` on the hologit repo itself.

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
