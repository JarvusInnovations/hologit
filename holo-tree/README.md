# holo-tree

Mutable in-memory git trees via [gitoxide](https://github.com/GitoxideLabs/gitoxide). Read, navigate, merge, and write git trees directly through packfile and loose object access — no git subprocess needed.

This crate provides the shared tree primitive used by [holo-projector](../holo-projector/) (holobranch projection) and [gitsheets](https://github.com/JarvusInnovations/gitsheets) (record-oriented git storage).

## Core features

- **MutableTree** — lazy-loaded children, dirty tracking, three merge modes (overlay, replace, underlay)
- **Glob matching** — minimatch-compatible patterns with negation support
- **Tree cache** — thread-local cache eliminates redundant ODB reads across recursive operations
- **Repo helpers** — ref resolution with tag peeling, commit creation, ref updates
- **TOML reader** — parse TOML config directly from git blobs

## Usage

```rust
use holo_tree::{MutableTree, MergeMode, MergeOptions, ObjectId};

// Open a repo and load a tree
let repo = gix::open(".")?;
let mut target = MutableTree::new(some_tree_hash);
let mut source = MutableTree::new(other_tree_hash);

// Merge with glob filtering
let opts = MergeOptions::new(
    Some(&["**/*.rs".into(), "!tests/**".into()]),
    MergeMode::Overlay,
)?;
target.merge(&repo, &mut source, &opts, ".")?;

// Write modified tree to ODB
let result_hash = target.write(&repo)?;
```

## Building

Part of the [hologit](../) Cargo workspace:

```sh
# Run tests
cargo test -p holo-tree

# Use as a dependency
[dependencies]
holo-tree = { git = "https://github.com/JarvusInnovations/hologit" }
```
