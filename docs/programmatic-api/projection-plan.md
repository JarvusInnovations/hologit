# ProjectionPlan

`ProjectionPlan` is a fluent builder API for the common case of composing multiple git sources into a single layered tree. It wraps the lower-level `Workspace`, `Branch`, `Source`, `Mapping`, and `Projection` classes into a concise interface.

## Basic Usage

```javascript
const { Repo } = require('hologit');
const ProjectionPlan = require('hologit/lib/ProjectionPlan');

const repo = new Repo({ gitDir: '/path/to/.git', ref: 'HEAD' });

const plan = new ProjectionPlan(repo);
plan.addLayer('base', { url: '/path/to/base', ref: 'refs/heads/main' });
plan.addLayer('overlay', { url: '/path/to/overlay', ref: 'refs/heads/main' }, { after: ['base'] });

const treeHash = await plan.project();
```

## API

### `new ProjectionPlan(repo)`

Create a new plan. Requires a `Repo` instance for git object storage.

### `plan.addSource(name, config)`

Register a named source. Returns `this` for chaining.

**config shape:**

| Field | Required | Description |
|-------|----------|-------------|
| `url` | yes | Git URL or local filesystem path |
| `ref` | yes | Git ref (`refs/heads/main`, `refs/tags/v1.0`, commit hash) |
| `project` | no | `{ holobranch: 'name' }` — project through a holobranch in the source |

### `plan.addMapping(sourceName, config)`

Add a mapping for a previously registered source. Returns `this` for chaining.

**config shape:**

| Field | Default | Description |
|-------|---------|-------------|
| `files` | `['**']` | Glob patterns for which files to include |
| `root` | `'.'` | Subtree of the source to map from |
| `output` | `'.'` | Target path in the output tree |
| `layer` | source name | Layer name for ordering |
| `after` | `null` | Sources/layers this must come after |
| `before` | `null` | Sources/layers this must come before |

### `plan.addLayer(name, sourceConfig, mappingConfig?)`

Convenience method that calls `addSource` then `addMapping`. Returns `this` for chaining.

This is the most common way to build a plan — each layer is a source that maps all its files (`**`) into the output tree:

```javascript
plan.addLayer('skeleton', { url: skeletonRepo, ref: 'refs/heads/main' });
plan.addLayer('product', { url: productRepo, ref: 'refs/tags/v3.0' }, { after: ['skeleton'] });
plan.addLayer('site', { url: siteRepo, ref: 'refs/heads/main' }, { after: ['product'] });
```

### `plan.project(options?)`

Compose all layers and return the git tree hash. This is an async operation.

**options:**

| Field | Default | Description |
|-------|---------|-------------|
| `lens` | `false` | Whether to apply hololens transformations |
| `fetch` | `false` | Whether to fetch remote sources |

## Layer Ordering

Layers are composed in topological order based on `after`/`before` constraints. When two layers contain a file at the same path, the layer that comes later wins.

A typical pattern is to chain layers sequentially:

```javascript
plan.addLayer('skeleton', { url: skeletonUrl, ref: skeletonRef });
plan.addLayer('product', { url: productUrl, ref: productRef }, { after: ['skeleton'] });
plan.addLayer('site', { url: siteUrl, ref: siteRef }, { after: ['product'] });
```

This ensures: skeleton files are laid down first, product files overlay them, site files overlay everything.

### Additive directories

Files in different directories from different layers coexist naturally. If `skeleton` provides `config/search.config.d/people.ts` and `product` provides `config/search.config.d/sections.ts`, both files appear in the output. Only files at the **same path** are overridden.

## Full Example: Emergence-style Layer Stack

```javascript
const { Repo } = require('hologit');
const ProjectionPlan = require('hologit/lib/ProjectionPlan');
const { execSync } = require('child_process');

async function composeEmergenceSite({ gitDir, layers }) {
  const repo = new Repo({ gitDir, ref: 'HEAD' });
  const plan = new ProjectionPlan(repo);

  let prevName = null;
  for (const layer of layers) {
    const mappingConfig = prevName ? { after: [prevName] } : {};
    plan.addLayer(layer.name, {
      url: layer.url,
      ref: layer.ref || 'refs/heads/main'
    }, mappingConfig);
    prevName = layer.name;
  }

  return plan.project();
}

// Usage
const treeHash = await composeEmergenceSite({
  gitDir: '/path/to/object-store',
  layers: [
    { name: 'skeleton', url: 'https://github.com/org/skeleton', ref: 'refs/tags/v2.12.0' },
    { name: 'slate', url: 'https://github.com/org/slate', ref: 'refs/tags/v2.21.0' },
    { name: 'slate-cbl', url: 'https://github.com/org/slate-cbl', ref: 'refs/tags/v3.1.0' },
    { name: 'school-site', url: '/local/school-site', ref: 'refs/heads/main' },
  ]
});

// Check out the composed tree
const git = await (new Repo({ gitDir: '/path/to/object-store', ref: 'HEAD' })).getGit();
await git.readTree(treeHash);
await git.checkoutIndex({ a: true, f: true });
```

## Relationship to Lower-Level API

`ProjectionPlan` is syntactic sugar over the [composition API](composition.md). Under the hood:

1. Source configs become phantom `Source` instances via `Workspace({ sources: {...} })`
2. Mapping configs become phantom `Mapping` instances via `Branch({ mappings: {...} })`
3. `project()` calls `Projection.projectBranch()` on the constructed branch

Use `ProjectionPlan` for standard layer composition. Use the lower-level API when you need:

- Custom `root` or `output` paths per mapping
- Glob filtering (`files`) to include only specific file patterns from a source
- Lens transformations
- Multiple branches in one workspace
- Direct access to the `TreeObject` before projection
