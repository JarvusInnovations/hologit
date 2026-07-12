# holo-projector-napi

Node.js native binding for [`holo-projector`](../holo-projector) — the Rust
holobranch composition engine, via [gitoxide](https://github.com/GitoxideLabs/gitoxide),
with no `git` subprocess.

This is the delivery vehicle for the hybrid CLI (`specs/behaviors/engine-selection.md`):
`lib/RustEngine.js` loads this binding from the in-repo build and delegates
pure composition to it, while the JS engine keeps ownership of side effects
(fetching, lensing, commits, watch). If the addon isn't built, the CLI runs
pure-JS exactly as before.

## API

Specced in [`specs/api/projector-napi.md`](../specs/api/projector-napi.md).

```js
const { compositeBranch, projectBranch, projectPlan } = require('@hologit/holo-projector');

// Pre-lens composed tree (.holo/{branches,sources} stripped; .holo/config.toml
// and .holo/lenses retained for a host-driven lens phase):
const preLens = compositeBranch('/repo/.git', rootTreeOrCommitHash, 'docs-site');

// Full composition-only projection (final metadata strip included):
const tree = projectBranch('/repo/.git', rootTreeOrCommitHash, 'docs-site');

// Structured-config composition (the ProjectionPlan path):
const composed = projectPlan('/repo/.git',
    [{ name: 'base', ref: 'refs/heads/main' }],
    [{ source: 'base' }]);
```

Errors carry a stable `code` property (`SOURCE_RESOLUTION`,
`LENSED_SUBPROJECTION`, `CONFIG`, …, plus the holo-tree codes and `PANIC`);
match on codes, never message prose. Panics are contained at the FFI boundary
and never abort the host process.

## Building

```sh
npm install
npm run build         # release; emits holo-projector.<platform>.node
npm run build:debug   # faster compile for development
npm test              # node --test suite (requires a built addon)
```

From the repo root, `npm run build:projector-addon` does the install + release
build in one step (this is what `test-cli` CI uses).

## Publication (deferred)

This package is **not published yet** — the CLI loads it via a relative
require with graceful degradation, so `npm install hologit` consumers see no
change. The packaging (napi config, committed `index.js`/`index.d.ts`,
platform triples) mirrors [`holo-tree-napi`](../holo-tree-napi) so that
publication is a follow-up workflow away. When that happens, the release tag
track must be prefix-namespaced (e.g. `holo-projector-v*`) — **never a bare
`v*` tag**, which collides with the `hologit` JS release namespace and the
`publish-npm.yml` trigger.
