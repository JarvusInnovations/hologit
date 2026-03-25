# Programmatic API

Hologit can be used as an npm module to compose git trees programmatically, without `.holo/` TOML configuration files in the source repositories.

## Installation

```bash
npm install hologit
```

## Exported API

```javascript
const {
  Git,          // Git CLI wrapper
  Repo,         // Git repository instance
  Workspace,    // Container for sources, branches, and lenses
  Branch,       // A holobranch with mappings
  Source,       // A holosource (remote git ref)
  Mapping,      // A holomapping (source → output path)
  Lens,         // A hololens (transformation)
  Projection,   // Orchestrates composition + lens pipeline
  TreeObject,   // In-memory git tree representation
  BlobObject,   // In-memory git blob representation
  SpecObject,   // Content-addressable spec for caching
  Studio,       // Docker execution environment manager
} = require('hologit');
```

## Two Modes of Use

### TOML-driven (traditional)

Hologit reads `.holo/sources/*.toml`, `.holo/branches/*/*.toml`, and `.holo/lenses/*/*.toml` from a git tree to define the composition. This is how the `git holo project` CLI works.

```javascript
const { Repo, Projection } = require('hologit');

const repo = await Repo.getFromEnvironment();
const workspace = await repo.getWorkspace();
const branch = await workspace.getBranch('my-holobranch');
const treeHash = await Projection.projectBranch(branch);
```

### Programmatic (no TOML required)

Sources, branches, and mappings are constructed in memory using the **phantom config** mechanism. The source repositories don't need any `.holo/` directory.

```javascript
const { Repo, Workspace, Branch, Projection } = require('hologit');

const repo = new Repo({ gitDir: '/path/to/.git', ref: 'HEAD' });
const rootTree = repo.createTree();
await rootTree.writeChild('.holo/config.toml', '[holospace]\nname = "my-project"\n');

const workspace = new Workspace({
  root: rootTree,
  sources: {
    'base': { url: '/path/to/base-repo', ref: 'refs/heads/main' },
    'overlay': { url: '/path/to/overlay-repo', ref: 'refs/heads/main' }
  }
});

const branch = new Branch({
  workspace,
  name: 'composed',
  phantom: {},
  mappings: {
    '_base': { holosource: 'base', files: ['**'] },
    '_overlay': { holosource: 'overlay', files: ['**'], after: ['base'] }
  }
});

const treeHash = await Projection.projectBranch(branch, { lens: false });
```

The result is a git tree hash — the same content-addressable output that the CLI produces. You can check it out, diff it, or compose it further.

## Guides

- **[Composition](composition.md)** — How to compose git trees programmatically
- **[ProjectionPlan](projection-plan.md)** — Fluent builder API for common composition patterns
