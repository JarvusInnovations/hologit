# Hologit Projection Engine — Rust Implementation Specification

## Overview

This document specifies a production Rust implementation of hologit's **projection engine**: the system that composes git trees from multiple sources according to declarative configuration stored in `.holo/` directories within git repositories.

The projection engine is the performance-critical core of hologit. A proof-of-concept Rust implementation demonstrated a **~100x speedup** over the Node.js version (58ms vs 6,000ms) on a real-world projection with 3,000+ tree writes, by eliminating the serialization boundary between the application and git's object store.

This specification covers the composition and commit phases. Lensing (container-based transformations) is specified as an integration boundary but its container orchestration remains in the Node.js CLI layer — it is inherently I/O-bound and benefits little from a rewrite.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI / Node.js FFI layer  (commands, watch, lens exec)  │
└─────────────┬───────────────────────────────────────────┘
              │  project_branch(git_dir, ref, branch_name) → tree hash
              ▼
┌─────────────────────────────────────────────────────────┐
│                    Rust projection engine                │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │  config   │  │  source  │  │  branch  │  │ commit │  │
│  │  (TOML)  │  │ resolver │  │ composer │  │ writer │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │             │             │             │       │
│       ▼             ▼             ▼             ▼       │
│  ┌──────────────────────────────────────────────────┐   │
│  │              tree  (merge, write, cache)          │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │          gix  (packfile, loose objects, refs)     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Crate structure

```
holo-engine/
├── Cargo.toml
├── src/
│   ├── lib.rs          # Public API: project_branch(), ProjectOptions
│   ├── tree.rs         # MutableTree, Child, merge, write, cache
│   ├── config.rs       # TOML config types, parsing from git blobs
│   ├── workspace.rs    # Workspace: config, branch/source/lens discovery
│   ├── branch.rs       # Branch: mapping discovery, toposort, composite
│   ├── source.rs       # Source: head resolution, spec hashing, fetch
│   ├── projection.rs   # Projection: orchestrate compose → strip → write
│   ├── commit.rs       # Commit creation, ref updates
│   ├── glob.rs         # Minimatch-compatible glob with negation
│   └── error.rs        # Error types
├── tests/
│   ├── helpers/
│   │   └── sandbox.rs  # Git sandbox for integration tests
│   ├── tree_merge.rs   # Tree merge unit tests
│   ├── glob.rs         # Glob matching unit tests
│   ├── config.rs       # Config parsing tests
│   ├── toposort.rs     # Topological sort tests
│   ├── source.rs       # Source resolution tests
│   └── projection.rs   # End-to-end projection tests
└── benches/
    └── projection.rs   # Criterion benchmarks
```

The engine is a library crate (`holo-engine`) with no CLI of its own. It is consumed by:

1. **The Node.js CLI** via `napi-rs` native addon (primary integration path)
2. **A thin Rust CLI** for benchmarking and standalone use
3. **Tests** via the library API directly

---

## Module Specifications

### 1. `tree` — Mutable Git Tree

The tree module is the innermost hot path. It provides an in-memory mutable tree that reads from and writes to the git object store through gix.

#### Data structures

```rust
/// An in-memory mutable git tree. Children are loaded lazily from the ODB
/// on first access and tracked via a BTreeMap for deterministic iteration
/// order matching git's canonical tree entry sort.
pub struct MutableTree {
    hash: ObjectId,
    dirty: bool,
    children: Option<BTreeMap<String, Child>>,
}

pub enum Child {
    Tree(MutableTree),
    Blob { mode: u16, hash: ObjectId },
    Commit { hash: ObjectId },  // gitlink
}
```

`BTreeMap` is required (not `HashMap`) because:

- Git tree entries have a canonical sort order
- The JS implementation iterates children in insertion order, which matches git's sorted output
- HashMap's random iteration order causes different merge results for unconstrained mappings that target overlapping output paths

#### Operations

| Method | Description |
|--------|-------------|
| `ensure_children(repo)` | Lazy-load children from ODB if not yet loaded. Check module-level cache first. |
| `get_child(repo, path)` | Navigate dot-separated path, return `Option<&Child>` |
| `get_subtree(repo, path)` | Navigate to a subtree, returning `None` if any component is missing |
| `get_or_create_subtree(repo, path)` | Navigate to a subtree, creating intermediate trees as needed. **Must mark all ancestors dirty when creating new nodes.** |
| `read_blob(repo, path)` | Read a blob's content by path |
| `write_child(repo, path, content)` | Write a blob at a path, creating intermediates |
| `delete_child(repo, name)` | Remove a direct child, mark dirty |
| `merge(repo, input, options, base_path)` | Merge another tree into this one (see below) |
| `write(repo)` | Recursively write dirty trees to ODB, return root hash |

#### Preload optimization

The JS implementation has a `preloadChildren` flag on `_loadBaseChildren()` and `merge()`. When true (the default for merge), it uses a single recursive `git ls-tree -r -t` call to load an entire tree hierarchy at once, populating the cache for all subtrees. This avoids one ODB read per tree level during merge traversal.

In the Rust implementation, gix's direct packfile access makes individual tree reads fast enough that the preload optimization is less critical. However, for very large source trees, a similar bulk-load approach could be implemented by walking the gix tree recursively and populating the cache. This is a **future optimization**, not required for correctness.

#### Module-level tree cache

A thread-local `HashMap<ObjectId, Vec<TreeEntry>>` caches parsed tree contents by hash. This is the single most impactful optimization — it eliminates redundant ODB reads when the same tree is referenced by multiple sources or across recursive projections.

```rust
thread_local! {
    static TREE_CACHE: RefCell<HashMap<ObjectId, Vec<TreeEntry>>> = RefCell::new(HashMap::new());
}
```

#### Merge algorithm

The merge algorithm is a direct port of `TreeObject.merge()` from the JS codebase. It is the most complex and performance-critical function in the engine.

**Inputs:**

- `self`: the target tree (mutated in place)
- `input`: the source tree (read-only borrow)
- `options`: merge mode + compiled glob patterns
- `base_path`: accumulated path prefix for glob matching

**Algorithm:**

```
for each child in input.children:
    if child.hash == self.child.hash and both clean:
        skip (identical subtree optimization)

    build child_path = base_path + child_name (+ "/" if tree)

    if glob patterns active:
        check (matched, negation_excluded) against child_path
        if negation_excluded: skip
        if not matched and is blob: skip
        if is tree and (not matched or has negations):
            set pending_child_match = true

    if blob:
        if underlay: write only if target has no entry at this name
        else (overlay or replace): always write

    if tree:
        if target has no tree at this name (or replace mode):
            if pending_child_match:
                merge input into empty temp tree
                insert temp only if it became dirty
            else if input child is clean:
                clone input child by hash (skip recursive merge)
            else:
                merge input into new empty tree, insert
        else (both sides are trees):
            recursive merge into existing target tree
            propagate dirty flag upward

    if replace mode:
        remove target children not present in input
```

**Critical invariants:**

- Dirty propagation: when a child tree becomes dirty, all ancestors up to the root must be marked dirty. The JS uses a `parent` pointer chain; the Rust version propagates during `write()` by checking child dirty flags, and during `get_or_create_subtree` by marking ancestors when creating new nodes.
- The "clone clean input" optimization (copying a tree by hash without loading its children) is essential for performance — it avoids reading thousands of tree objects that are used as-is.

#### Write algorithm

```
if not dirty: return self.hash (skip)

for each child:
    if child is dirty tree: recurse write(child)
    if child is empty tree: skip (don't write empty trees)
    collect (name, mode, hash) entry

sort entries (git canonical order)
build gix::objs::Tree { entries }
write via repo.write_object()
update self.hash, clear dirty flag
```

#### Stats tracking

Atomic counters for: trees_read, trees_written, trees_skipped_clean, cache_hits, cache_misses, blobs_read. Exposed via a `stats()` function for benchmarking and diagnostics.

---

### 2. `glob` — Minimatch-Compatible Glob Matching

A dedicated module that wraps `globset` with corrections for minimatch compatibility. This exists because globset and minimatch differ in meaningful ways that affect projection correctness.

**Important:** The JS uses `Minimatch` with `{ dot: true }`, which means patterns like `*` and `**` match dotfiles (`.gitignore`, `.github/`, etc.). Globset matches dotfiles by default, so no special handling is needed for this — but it must be verified in tests.

#### Differences from globset that must be handled

| Pattern | Path | minimatch | globset | Fix |
|---------|------|-----------|---------|-----|
| `**/*.php` | `Admin.php` | match | no match | Add `*.php` as additional pattern |
| `**/*` | `file.txt` | match | no match | Add `*` as additional pattern |
| `!.github/` | `.github/` | negation | parse error | Strip `!` prefix, track as negation |

#### Data structures

```rust
struct PatternEntry {
    glob: GlobSet,      // compiled globset (may contain 2 patterns for ** fix)
    negate: bool,       // true if original pattern started with !
}

pub struct GlobMatcher {
    patterns: Option<Vec<PatternEntry>>,
}
```

#### Matching semantics

```rust
impl GlobMatcher {
    /// Returns (matched, negation_excluded).
    /// A negation hit takes priority and short-circuits.
    pub fn matches(&self, path: &str) -> (bool, bool);

    /// Returns true if any pattern could potentially match
    /// children of this directory path.
    pub fn might_match_children(&self, dir_path: &str) -> bool;

    /// Returns true if patterns were provided (not match-everything).
    pub fn has_patterns(&self) -> bool;

    /// Returns true if any negation patterns exist.
    pub fn has_negations(&self) -> bool;
}
```

The `**` zero-segment fix is applied at construction time: for any pattern starting with `**/`, a second pattern with the `**/` prefix stripped is added to the same `GlobSet`. This makes `**/*.php` match both `dir/file.php` and `file.php`.

---

### 3. `config` — TOML Configuration Types

Defines serde-deserializable types for all `.holo/` TOML files and provides functions to read them from git tree blobs.

#### Config types

```rust
// .holo/config.toml
struct WorkspaceConfig { name: Option<String> }

// .holo/branches/{name}.toml
struct BranchConfig { extend: Option<String>, lens: Option<bool> }

// .holo/branches/{branch}/{key}.toml
struct MappingConfig {
    holosource: String,
    files: Vec<String>,
    root: String,       // normalized path, default "."
    output: String,     // computed from key + config
    layer: String,      // default = holosource
    before: Vec<String>,
    after: Vec<String>,
}

// .holo/sources/{name}.toml
struct SourceConfig {
    url: Option<String>,
    ref_: Option<String>,
    project: Option<SourceProjectConfig>,
}

// .holo/lenses/{name}.toml (read-only, for stripping)
struct LensConfig { ... }
```

#### Config reading

```rust
/// Read and parse a TOML blob from a git tree.
pub fn read_toml<T: DeserializeOwned>(
    repo: &Repository,
    tree: &mut MutableTree,
    path: &str,
) -> Result<Option<T>>;
```

#### Mapping discovery

Mappings are discovered by walking `.holo/branches/{name}/` recursively. **Important:** The JS uses BFS (a `searchQueue` with `shift()`), but with BTreeMap-ordered children and DFS, the results are equivalent because all children at each tree level are discovered before recursing. The critical requirement is that children within each directory are iterated in alphabetical (git tree) order, not that the walk be BFS vs DFS. Both produce the same ordering when children are sorted.

Each `.toml` file found becomes a mapping. The mapping key is the file's path relative to the branch directory, minus the `.toml` extension. Subdirectories are namespace prefixes.

**Output path computation** (must match `Mapping.getConfig()` in JS):

```
key = "php-classes/Gitonomy/Git"
basename = "Git"
dirname = "php-classes/Gitonomy"

if basename starts with '_':
    output = normalize(dirname + "/" + config.output)
else:
    output = normalize(dirname + "/" + basename + "/" + config.output)
```

**Holosource defaulting:**

- If no `holosource` in config: default to `basename.strip_prefix('_')`
- If `holosource` starts with `=>`: prepend the local name

---

### 4. `workspace` — Workspace

Represents a holospace: the root tree plus its discovered branches, sources, and lenses.

```rust
pub struct Workspace {
    root: MutableTree,
    config: WorkspaceConfig,
    // Cached discoveries
    branches: OnceCell<BTreeMap<String, Branch>>,
    sources: OnceCell<BTreeMap<String, Source>>,
}
```

The workspace reads `.holo/config.toml` on construction to determine the workspace name (used for self-source identification).

**Programmatic construction:** Support phantom sources and branches passed as parameters (no TOML files needed), matching the Node.js programmatic API from PR #425.

---

### 5. `branch` — Branch Composition

A branch represents a holobranch. It discovers its mappings, topologically sorts them, and composites them into an output tree.

#### Topological sort

Mappings are sorted by `before`/`after` constraints using Kahn's algorithm with a `VecDeque` queue for stable ordering. Nodes with no constraints preserve their discovery order.

**Wildcard expansion:** `after: "*"` expands to all other layers. `before: "*"` expands to all other layers.

**Error:** Circular dependencies are detected when the sorted output has fewer elements than the input.

#### Composition

```rust
pub fn composite(
    &self,
    repo: &Repository,
    workspace: &mut Workspace,
    output: &mut MutableTree,
) -> Result<()>;
```

For each mapping in sorted order:

1. Resolve the source via `source::resolve()`
2. Navigate to the source tree at `mapping.root`
3. Navigate to (or create) the output subtree at `mapping.output`
4. Merge the source tree into the output subtree with the mapping's file patterns

#### Extends chain

A branch may declare `extend = "other-branch"`. The extends chain is resolved iteratively (not recursively) by collecting branches into a stack, then compositing in reverse order (base first).

---

### 6. `source` — Source Resolution

Sources are the most complex component because they have multiple resolution strategies.

#### Resolution chain

A source name may contain `=>` to specify a mapping holobranch: `laddr=>emergence-skeleton` means "resolve `laddr`, then project `emergence-skeleton` within it."

```rust
pub fn resolve(
    repo: &Repository,
    workspace: &mut Workspace,
    source_name: &str,
) -> Result<ObjectId>;  // returns a tree hash
```

**Resolution order:**

1. **Self-source:** If `base_name == workspace.name`, return the workspace root tree hash.

2. **Gitlink:** Check `.holo/sources/{name}` for a commit-type tree entry (mode 160000). If found, use that commit.

3. **Spec ref:** Compute the source's spec hash from its URL, build `refs/holo/source/{hash[0:2]}/{hash[2:]}/{ref_suffix}`, and resolve via `rev_parse`.

4. **Local ref:** Try resolving the source's `ref` config value directly.

5. **Error:** If all strategies fail, return an error. (The Rust engine does not fetch; the caller must ensure sources are available locally.)

**Environment variable overrides:** The JS allows overriding source configs via `HOLO_SOURCE_{NAME}` env vars (with `-` replaced by `_`, uppercased). The format is `url#ref=>holobranch`. This is primarily used in CI and should be supported in the production implementation. The PoC does not implement this.

**Self-source ($workspace):** When a source's `holosourceName` matches the workspace name, the JS sets a `$workspace: true` flag and returns the workspace root tree's written hash as the source head. This means the workspace tree (which may have been modified by previous composition steps in an outer projection) serves as its own source. The Rust PoC handles this by returning `workspace_tree.hash` directly.

**After resolving the base commit:**

1. **Tag peeling:** If the resolved object is a tag, peel to the underlying commit.

2. **Source projection:** If the source config has `project.holobranch`, recursively call `project_branch()` on the source's tree.

3. **Mapping holobranch:** If the source name contains `=>holobranch`, recursively call `project_branch()` on the (possibly already projected) tree.

#### Spec hash computation

The spec hash identifies a source by its normalized URL. It must produce byte-identical TOML to the JS implementation:

```
[holospec.source]
host = "github.com"
path = "/org/repo"
```

The hash is computed as: `SHA-1("blob {len}\0{toml_content}")`.

**URL normalization:**

- Parse URL to extract host and path
- Lowercase both
- Strip trailing `.git` and `/` from path
- For SSH URLs (`git@host:path`), extract host after `@` and prepend `/` to path
- For absolute paths, use `file://` scheme
- Keys must be sorted alphabetically (`host` before `path`)

---

### 7. `projection` — Orchestrator

The top-level function that ties everything together.

```rust
pub fn project_branch(
    repo: &Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
) -> Result<ObjectId>;
```

**Steps:**

1. Read workspace config from `root_tree_id`
2. Resolve the branch's `extend` chain
3. Composite each branch in the chain (base first) into an empty output tree
4. Strip `.holo/branches` and `.holo/sources` from output
5. Strip `.holo` entirely if only `config.toml` remains
6. Write the output tree to the ODB
7. Return the tree hash

**Lensing boundary:** The `project_branch` function accepts an optional `lens` callback that the caller can provide. For the Node.js integration, this callback invokes the existing JS lens infrastructure. The Rust engine does not implement container orchestration.

The lens integration point is between steps 4 and 5: after composition and metadata stripping, but before the final `.holo` cleanup. The callback receives the current output tree (writable) and the workspace, and can read lens configs from `.holo/lenses/` and `.holo/branches/{name}.lenses/`, build input trees, execute specs, and merge output trees — all using the same tree merge primitives. After lensing, `.holo/lenses` is stripped from the output.

**Recursive projection lens behavior:** When `project_branch` is called recursively (from source resolution), the lens flag comes from the inner branch's config (`holobranch.lens`), NOT from the outer projection's CLI flag. The spec's `ProjectOptions.lens_executor` should be passed through to recursive calls, but whether it's invoked depends on the branch config.

---

### 8. `commit` — Commit Creation

```rust
pub fn commit_projection(
    repo: &Repository,
    tree_hash: ObjectId,
    branch_name: &str,
    commit_to: &str,
    parent_commit: Option<ObjectId>,
    message: Option<&str>,
) -> Result<ObjectId>;
```

Creates a commit with:

- The projected tree as its tree
- The previous projection commit as first parent (or an init commit if none)
- Optionally the source commit as second parent
- Trailers: `Source-holobranch`, `Source-commit`, `Source`

Updates the target ref to point to the new commit.

---

### 9. `error` — Error Types

```rust
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("git error: {0}")]
    Git(#[from] gix::Error),

    #[error("config error in {path}: {message}")]
    Config { path: String, message: String },

    #[error("source '{name}' could not be resolved: {reason}")]
    SourceResolution { name: String, reason: String },

    #[error("circular dependency in {kind} ordering")]
    CircularDependency { kind: String },

    #[error("glob pattern error: {0}")]
    Glob(#[from] globset::Error),

    #[error("{0}")]
    Other(String),
}
```

---

## Public API

The library exposes a minimal public API:

```rust
/// Project a holobranch and return the resulting tree hash.
pub fn project_branch(
    repo: &gix::Repository,
    root_tree_id: ObjectId,
    branch_name: &str,
    options: &ProjectOptions,
) -> Result<ObjectId>;

pub struct ProjectOptions {
    /// Called for each lens encountered. Returns the lensed tree hash.
    /// If None, lensing is skipped.
    pub lens_executor: Option<Box<dyn FnMut(LensSpec) -> Result<ObjectId>>>,

    /// Whether to fetch sources (if false, all sources must be locally available).
    pub fetch: bool,
}

/// Reset all module-level caches and stats counters.
pub fn reset();

/// Return current performance statistics.
pub fn stats() -> Stats;
```

---

## Dependencies

| Crate | Purpose | Why this one |
|-------|---------|-------------|
| `gix` | Git object access | Direct packfile reads, no subprocess. The single biggest performance win. |
| `globset` | Glob pattern compilation | Compiles to Aho-Corasick automaton. Wrapped with minimatch compat layer. |
| `toml` + `serde` | TOML parsing | Standard, well-maintained. |
| `url` | URL parsing | For source spec hash computation. |
| `thiserror` | Error types | Ergonomic derive macros. |
| `anyhow` | Error propagation | Used in tests and CLI, not in library API. |

**Not included:**

- `topological-sort` — replace with inline Kahn's algorithm (~30 lines) for stable ordering
- `napi-rs` — added in a separate `holo-engine-napi` crate for Node.js binding
- `bollard` — future addition for Rust-native lens execution
- `clap` — only in the benchmark/CLI binary, not the library

---

## Test Suite

### Unit tests

#### `tests/tree_merge.rs` — Tree merge correctness

These tests use a git sandbox (bare repo created in a temp directory) to verify tree merge behavior against actual git objects.

**Overlay mode:**

- Overwrites existing blobs with source blobs
- Preserves target blobs not present in source
- Adds new blobs from source
- Recursively merges nested subtrees
- Skips merge when source and target subtrees have identical hashes

**Replace mode:**

- Removes target children not present in source
- Replaces target subtrees entirely with source subtrees
- Works correctly with nested directories

**Underlay mode:**

- Does not overwrite existing blobs
- Fills gaps with source blobs
- Does not overwrite existing subtrees

**Dirty tracking:**

- Merge marks target tree dirty
- Write resets dirty flag
- Dirty propagates to parent trees
- Unchanged merge (identical hashes) does not set dirty
- `get_or_create_subtree` marks all ancestors dirty

**Edge cases:**

- Merging empty tree into empty tree (no-op)
- Merging into self (should not corrupt)
- Very deep nesting (20+ levels)
- Trees with commit/gitlink entries (preserved but not recursed)
- Tree with mixed blob/tree children at same level
- Source tree with executable blobs (mode 100755) preserved correctly
- Source tree with symlinks (mode 120000) preserved correctly
- Merge with `files = ["**"]` is equivalent to no-filter merge (fast path)
- Sequential merges: merge A into target, then merge B into target — both reflected

#### `tests/glob.rs` — Glob matching correctness

**Basic patterns:**

- `**` matches everything
- `*.php` matches root-level PHP files
- `**/*.php` matches PHP files at any depth, **including root**
- `*/**` matches anything with at least one directory level
- `**/*` matches everything, including root files

**Negation:**

- `!.github/` excludes `.github/` directory
- `[**, !node_modules/**]` includes everything except node_modules
- `[**/*.php, !*.inc.php]` includes PHP but excludes .inc.php
- Negation takes priority over positive matches
- Multiple negations combine correctly

**Directory matching:**

- `dir/` pattern (trailing slash) matches directory entries
- `pending_child_match` correctly descends into unmatched directories
- `might_match_children` returns true for `**` patterns
- `might_match_children` returns false when no pattern could match

**Minimatch compatibility:**

- `**/*.php` matches `Admin.php` (zero segments for `**`)
- `**/*` matches `file.txt` (zero segments)
- `!Tests/**` excludes `Tests/` and all children
- `!Command/LintCommand.php` excludes specific file
- Dotfiles: `**` matches `.gitignore`, `.hidden/` (minimatch `dot: true` behavior)
- Path construction: blob at root = `name`, tree at root = `name/`, nested = `parent/name` or `parent/name/`

#### `tests/config.rs` — TOML config parsing

- Workspace config: reads name from `[holospace]`
- Branch config: reads extend and lens from `[holobranch]`
- Mapping config: reads all fields from `[holomapping]`
- Mapping defaults: holosource from basename, layer from holosource, root/output normalization
- Mapping with `_` prefix: output path collapses to parent directory
- Mapping with `=>` holosource: prepends local name
- Source config: reads url, ref, project from `[holosource]`
- StringOrVec: handles both `files = "**"` and `files = ["a", "b"]`
- Missing config file: returns None, not error
- Malformed TOML: returns descriptive error with file path

#### `tests/toposort.rs` — Topological sort

- No constraints: preserves insertion order
- Simple `after` constraint: A after B → B, A
- Simple `before` constraint: A before B → A, B
- Wildcard `after: "*"`: comes after all others
- Wildcard `before: "*"`: comes before all others
- Multiple constraints: complex DAG resolves correctly
- Circular dependency: detected and reported
- Stable ordering: unconstrained nodes preserve discovery order

#### `tests/source.rs` — Source resolution

- Self-source: returns workspace root tree hash
- Gitlink resolution: reads commit entry from `.holo/sources/{name}`
- Spec-ref resolution: computes correct spec hash, resolves ref
- Tag peeling: annotated tag → commit → tree
- Source with `project.holobranch`: triggers recursive projection
- Mapping holobranch (`=>` syntax): triggers recursive projection after source resolution
- Both project and mapping holobranch: applied in sequence
- Missing source: returns descriptive error
- Spec hash computation matches JS output for various URL formats:
  - HTTPS: `https://github.com/org/repo`
  - HTTPS with .git: `https://github.com/org/repo.git`
  - SSH: `git@github.com:org/repo.git`
  - File path: `/absolute/path`
  - No URL (local ref): path = "."

### Integration tests

#### `tests/projection.rs` — End-to-end projection

These tests create complete `.holo/` configurations in a git sandbox and verify the full projection pipeline.

**Simple projection:**

- Single self-source mapping with `files = ["**"]`
- Self-source with file glob filter
- Self-source with negation pattern
- Self-source with root path

**Multi-source projection:**

- Two sources merged in order
- Source with `before`/`after` ordering constraints
- Source with subpath root (`root = "src/lib"`)
- Source with custom output path

**Recursive projection:**

- Source with `project.holobranch` config
- Source with `=>holobranch` mapping syntax
- Branch with `extend` chain
- Multi-level recursion (source within source within source)

**Metadata stripping:**

- `.holo/branches` and `.holo/sources` removed from output
- `.holo` removed entirely when only `config.toml` remains
- `.holo/lenses` preserved (lensing not applied)

**Environment variable overrides:**

- `HOLO_SOURCE_MYSOURCE=https://other.url#refs/heads/main` overrides source URL and ref
- Hyphenated names: `my-source` → `HOLO_SOURCE_MY_SOURCE`
- Partial override: `#refs/heads/other` changes only ref, preserves URL
- Override with projection: `#refs/heads/main=>holobranch` sets project config

**Hash verification:**

- Run both JS and Rust engines on the same input, verify identical output hash
- This is the most critical test — it validates the entire pipeline

### Benchmarks

#### `benches/projection.rs` — Criterion benchmarks

- `bench_simple_projection`: single self-source, measures baseline overhead
- `bench_emergence_site`: the codeforphilly.org emergence-site projection (real-world, ~3,000 trees)
- `bench_tree_merge_large`: merge two large flat trees (1,000 entries each)
- `bench_tree_merge_deep`: merge deeply nested trees (20 levels)
- `bench_glob_matching`: pattern matching throughput

---

## Performance Requirements

Based on PoC benchmarks, the production implementation should achieve:

| Metric | Target | PoC achieved |
|--------|--------|-------------|
| emergence-site composition | < 100ms | 58ms |
| Simple single-source projection | < 5ms | ~1ms |
| Tree write throughput | > 50,000 trees/sec | ~53,000/sec |

### Performance-critical design decisions

1. **No allocation in the merge inner loop** where possible. Reuse buffers for path construction.
2. **BTreeMap for children** — slightly slower than HashMap for lookup, but eliminates the need for a separate sort step during write and ensures deterministic iteration.
3. **Thread-local tree cache** — avoids synchronization overhead while still caching within a single projection run.
4. **Lazy child loading** — trees are not read from git until their children are needed. The "clone clean input" optimization (copying a tree by hash) avoids ever loading trees that pass through unchanged.
5. **gix's memory-mapped packfile access** — tree reads go directly from mmap'd packfile data to parsed entries with minimal copying.

---

## Node.js Integration (napi-rs)

A separate crate `holo-engine-napi` provides the FFI boundary:

```rust
#[napi]
pub fn project_branch(
    git_dir: String,
    ref_: String,
    branch_name: String,
    no_lens: bool,
) -> napi::Result<String>;  // returns tree hash hex string
```

The napi crate:

- Opens the repo via gix
- Calls `holo_engine::project_branch()`
- Returns the hash as a hex string
- Provides `reset()` and `stats()` accessors

The Node.js CLI delegates to this for the composition phase, then handles lensing, commit, and watch in JS.

---

## Migration Path

1. **Phase 1: Library + benchmark parity** — Implement the spec above, verify hash-identical output for all existing test fixtures plus emergence-site.

2. **Phase 2: napi-rs binding** — Create the Node.js native addon. The existing CLI calls `Projection.projectBranch()` in JS; replace the composition portion with a call to the Rust engine via the native addon.

3. **Phase 3: Lens integration** — Pass a callback from JS that the Rust engine invokes for each lens. The Rust side builds the input tree and spec hash; the JS side executes the container and returns the output hash.

4. **Phase 4: Standalone CLI** — Optional. A pure Rust CLI that can run projections without Node.js, for CI environments and performance-sensitive deployments.
