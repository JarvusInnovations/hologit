# holo-projector

Holobranch projection engine — compose git trees from multiple sources according to declarative `.holo/` configuration. Built on [holo-tree](../holo-tree/) for direct gitoxide packfile access.

## What it does

Given a git tree containing `.holo/` configuration (workspace, branches, sources, mappings), the projector:

1. Discovers and topologically sorts mappings by dependency constraints
2. Resolves each source (gitlinks, spec-refs, local refs, with tag peeling)
3. Recursively projects inner holobranches when configured
4. Merges source trees into the output with glob filtering
5. Strips `.holo/` metadata from the output
6. Writes and returns the final tree hash

## Two entry points

**TOML-driven** — reads `.holo/` config from a git tree (used by `git holo project`):

```rust
let hash = holo_projector::project_branch(&repo, root_tree_id, "my-branch")?;
```

**Programmatic** — accepts structured definitions directly (used by `ProjectionPlan`):

```rust
let hash = holo_projector::project_plan(&repo, &sources, &mappings)?;
```

## CLI

A benchmark/testing CLI is available behind a feature flag:

```sh
cargo build --release -p holo-projector --features cli
./target/release/holo-project --repo /path/to/repo --ref HEAD --stats my-branch
```

## Building

Part of the [hologit](../) Cargo workspace:

```sh
# Run tests
cargo test -p holo-projector

# Build CLI
cargo build --release -p holo-projector --features cli
```

## Performance

Benchmarked on [CodeForPhilly/codeforphilly.org](https://github.com/CodeForPhilly/codeforphilly.org) `emergence-site` — a complex projection with 3,057 tree writes, 9 recursive sub-projections, and 50+ sources:

|      | Node.js | Rust  | Speedup  |
| ---- | ------- | ----- | -------- |
| Warm | 3,500ms | 27ms  | **130x** |
| Cold | 3,500ms | 100ms | **35x**  |

All projections produce hash-identical output to the Node.js engine.

## Current gaps

The Rust engine handles the composition phase. These capabilities remain in the Node.js CLI:

- **napi-rs binding** — the Node.js CLI still uses its own JS projection engine ([#434](https://github.com/JarvusInnovations/hologit/issues/434))
- **Lensing** — container-based transformations via Docker/Habitat ([#435](https://github.com/JarvusInnovations/hologit/issues/435))
- **Source fetching** — all sources must be available locally ([#436](https://github.com/JarvusInnovations/hologit/issues/436))
- **Watch mode** — continuous re-projection on file changes ([#437](https://github.com/JarvusInnovations/hologit/issues/437))
- **Commit creation** — projection commits with dual parents and trailers ([#438](https://github.com/JarvusInnovations/hologit/issues/438))
