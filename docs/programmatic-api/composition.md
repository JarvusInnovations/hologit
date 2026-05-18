# Programmatic Composition

This guide covers how to compose git trees programmatically using hologit's core classes. No `.holo/` TOML files are needed in the source repositories.

## Creating a Repo

Every hologit operation starts with a `Repo` instance. The repo provides git object storage — hologit creates tree and blob objects in its object database.

```javascript
const { Repo } = require('hologit');

// From a working directory
const repo = await Repo.getFromEnvironment();

// From explicit paths
const repo = new Repo({
  gitDir: '/path/to/.git',
  ref: 'HEAD',
  workTree: '/path/to/workdir'  // optional
});
```

The repo doesn't need to contain any project files — it's used purely for git object storage. You can point it at a bare repo created just for this purpose:

```javascript
const { execSync } = require('child_process');

execSync('git init --bare /tmp/compose-store');
const repo = new Repo({ gitDir: '/tmp/compose-store', ref: 'HEAD' });
```

## The Phantom Mechanism

All hologit configuration objects (`Source`, `Branch`, `Mapping`, `Lens`) extend `Configurable`, which supports two config sources:

1. **TOML from a git tree** — the traditional mode, reading `.holo/sources/name.toml` etc.
2. **Phantom config** — an in-memory object passed at construction time

When `phantom` config is provided, hologit uses it directly without reading any TOML files. This is the foundation of the programmatic API.

## Constructing a Workspace

A `Workspace` is the container for sources and branches. It requires a root tree (which must contain a minimal `.holo/config.toml`).

The `sources` parameter accepts a plain object of `{ name: config }` entries. Each config object is automatically wrapped in a phantom `Source` instance:

```javascript
const { Workspace } = require('hologit');

const rootTree = repo.createTree();
await rootTree.writeChild('.holo/config.toml', '[holospace]\nname = "my-project"\n');

const workspace = new Workspace({
  root: rootTree,
  sources: {
    'framework': { url: 'https://github.com/org/framework', ref: 'refs/tags/v2.0.0' },
    'app': { url: '/local/path/to/app', ref: 'refs/heads/main' },
    'theme': { url: 'https://github.com/org/theme', ref: 'refs/heads/main' }
  }
});
```

### Source config shape

| Field | Required | Description |
|-------|----------|-------------|
| `url` | yes | Git URL or local filesystem path to the source repository |
| `ref` | yes | Git ref to read from (`refs/heads/main`, `refs/tags/v1.0`, a commit hash) |
| `project` | no | `{ holobranch: 'name' }` — if the source itself has holobranches, project through one before using |

Local filesystem paths are resolved as-is. Remote URLs are fetched into the repo's object database.

You can also pass pre-constructed `Source` instances:

```javascript
const source = new Source({
  workspace,
  name: 'framework',
  phantom: { url: '...', ref: '...' }
});

const workspace = new Workspace({
  root: rootTree,
  sources: { 'framework': source }
});
```

## Constructing a Branch with Mappings

A `Branch` defines how sources are combined. The `mappings` parameter accepts a plain object of `{ key: config }` entries:

```javascript
const { Branch } = require('hologit');

const branch = new Branch({
  workspace,
  name: 'composed',
  phantom: {},
  mappings: {
    '_framework': {
      holosource: 'framework',
      files: ['**']
    },
    '_app': {
      holosource: 'app',
      files: ['**'],
      after: ['framework']
    },
    '_theme': {
      holosource: 'theme',
      files: ['styles/**', 'assets/**'],
      output: '.',
      after: ['framework']
    }
  }
});
```

### Mapping config shape

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `holosource` | yes | — | Name of the source to pull from |
| `files` | no | `['**']` | Glob patterns for which files to include |
| `root` | no | `'.'` | Subtree of the source to map from |
| `output` | no | `'.'` | Target path in the output tree |
| `layer` | no | source name | Layer name for ordering |
| `after` | no | `null` | Array of source/layer names this mapping must come after |
| `before` | no | `null` | Array of source/layer names this mapping must come before |

### Mapping keys

Mapping keys (the object property names) follow the hologit convention of underscore-prefixed names: `_framework`, `_app`, `_theme`. The key is used internally for identification and sorting.

### Ordering

Mappings are topologically sorted based on `after` and `before` constraints. When two sources define a file at the same path, the mapping that comes later in the sort order wins (its file overwrites the earlier one).

Use `after: ['*']` to ensure a mapping comes last (highest priority).

## Projecting

Once you have a branch, project it to get a composed git tree hash:

```javascript
const { Projection } = require('hologit');

const treeHash = await Projection.projectBranch(branch, {
  lens: false,     // skip lens transformations
  fetch: false     // don't fetch remote sources (they must already be available)
});
```

The returned `treeHash` is a standard git tree object hash. You can use it with any git command:

```bash
# Inspect the tree
git ls-tree -r <treeHash>

# Read a specific file
git cat-file -p <treeHash>:path/to/file.js

# Check out to a directory
GIT_DIR=/path/to/.git GIT_WORK_TREE=/output git read-tree <treeHash>
GIT_DIR=/path/to/.git GIT_WORK_TREE=/output git checkout-index -a -f
```

Or programmatically via hologit's git wrapper:

```javascript
const git = await repo.getGit();

// Read a file from the composed tree
const content = await git.catFile({ p: true }, `${treeHash}:routes/api/people/index.ts`);

// List all files
const listing = await git.lsTree({ r: true }, treeHash);

// Diff two composed trees
const diff = await git.diffTree({ r: true, 'name-only': true }, oldTreeHash, newTreeHash);
```

## Full Example

Compose a framework layer with an application layer, where the application overrides specific files:

```javascript
const { Repo, Workspace, Branch, Projection } = require('hologit');
const { execSync } = require('child_process');

// Set up a git repo for object storage
execSync('git init --bare /tmp/my-store');
const repo = new Repo({ gitDir: '/tmp/my-store', ref: 'HEAD' });

// Build the workspace with two sources
const rootTree = repo.createTree();
await rootTree.writeChild('.holo/config.toml', '[holospace]\nname = "my-app"\n');

const workspace = new Workspace({
  root: rootTree,
  sources: {
    'framework': {
      url: '/path/to/framework-repo',
      ref: 'refs/tags/v2.0.0'
    },
    'app': {
      url: '/path/to/app-repo',
      ref: 'refs/heads/main'
    }
  }
});

// Define the composition — app overlays framework
const branch = new Branch({
  workspace,
  name: 'production',
  phantom: {},
  mappings: {
    '_framework': {
      holosource: 'framework',
      files: ['**']
    },
    '_app': {
      holosource: 'app',
      files: ['**'],
      after: ['framework']  // app files override framework files at same paths
    }
  }
});

// Compose
const treeHash = await Projection.projectBranch(branch, { lens: false });
console.log('Composed tree:', treeHash);

// Check out to a directory
const git = await repo.getGit();
await git.readTree(treeHash);
await git.checkoutIndex({ a: true, f: true });
```

This produces a single git tree containing all of `framework`'s files, with any files at the same path replaced by `app`'s versions — the same copy-on-write overlay semantics as hologit's TOML-driven composition.
