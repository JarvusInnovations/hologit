# @hologit/holo-projector

Holobranch projection and composition for Node.js — a native binding over
the [`holo-projector`](../holo-projector) Rust engine, powered by
[gitoxide](https://github.com/GitoxideLabs/gitoxide).

- **No `git` binary.** Everything runs in-process through gix; nothing
  shells out. Works anywhere Node runs, including environments with no git
  installed.
- **Composition, hash-identical.** Reads `.holo/` configuration from a git
  tree, resolves sources, and merges trees according to mappings — producing
  the same output hashes as the [hologit](https://github.com/JarvusInnovations/hologit)
  CLI's projection pipeline (`specs/behaviors/composition.md`).
- **Warm sessions.** One-shot functions for simple calls, or a
  `ProjectionSession` holding a persistent repository handle + tree cache
  for hosts that project repeatedly — watch cycles, servers, embedders.
- **Built for embedding.** Stable machine-matchable error codes, panic
  containment at the FFI boundary (a Rust bug can never abort your process),
  and no reliance on thread-implicit state.

This binding is the delivery vehicle for hologit's hybrid CLI
(`specs/behaviors/engine-selection.md`): `lib/RustEngine.js` delegates pure
composition to it while the JS engine keeps ownership of side effects
(fetching, lensing, commits, watch). The CLI loads it from the in-repo build
— if the addon isn't built, the CLI runs pure-JS exactly as before. As an
npm package it is the same engine, standalone, for any Node host.

## Install

```sh
npm install @hologit/holo-projector
```

Prebuilt release binaries ship as `optionalDependencies` for:
linux-x64-gnu, linux-arm64-gnu, linux-x64-musl, darwin-arm64, darwin-x64,
win32-x64-msvc (full matrix under [Publishing](#publishing)). No Rust
toolchain needed on supported platforms.

## Quick start

The API contract is specced in
[`specs/api/projector-napi.md`](../specs/api/projector-napi.md). All calls
are synchronous; object ids cross the boundary as lowercase 40-char hex
strings. `rootTree` accepts a tree hash, or a commit/tag hash which is
peeled to its tree.

```js
const { compositeBranch, projectBranch, projectPlan } = require('@hologit/holo-projector');

// Pre-lens composed tree (.holo/{branches,sources} stripped; .holo/config.toml
// and .holo/lenses retained for a host-driven lens phase):
const preLens = compositeBranch('/repo/.git', rootTreeOrCommitHash, 'docs-site');

// Full composition-only projection (final metadata strip included):
const tree = projectBranch('/repo/.git', rootTreeOrCommitHash, 'docs-site');

// Structured-config composition (no .holo/ config needed):
const composed = projectPlan('/repo/.git',
    [{ name: 'base', ref: 'refs/heads/main' }],
    [{ source: 'base' }]);
```

The top-level functions are one-shot (open repo, project, drop). Hosts making
repeat projections hold a **`ProjectionSession`** — a warm context
(persistent repository handle + tree cache) that only ever caches
content-addressed state, re-resolving refs on every call. It also exposes
`commitProjection` — create a projection commit and advance a ref per
`specs/behaviors/projection-commits.md`, with a compare-and-swap advance
that surfaces concurrent writers as `REF_CONFLICT`:

```js
const { ProjectionSession } = require('@hologit/holo-projector');

const session = new ProjectionSession('/repo/.git');
const tree = session.projectBranch(rootTreeOrCommitHash, 'docs-site'); // warm across calls
const commit = session.commitProjection({
    commitRef: 'holo/docs-site',
    holobranch: 'docs-site',
    tree,
    sourceCommit: rootCommitHash,
    sourceDescription: 'v1.2.3-4-gdeadbee', // host-computed `git describe`
});
```

### Session staleness contract

The session caches **only content-addressed state** (parsed trees keyed by
tree id) — immutable by construction, reusable forever. Everything mutable
is read fresh on every call: refs are never cached (a ref advanced behind
the session is observed by the next call), and objects written behind the
session are visible without reopening it. `cachedTrees()` exposes cache
warmth for observability; `clearCache()` is a memory valve for long-lived
hosts, never required for correctness.

## Errors: match on `code`, never on message

Every failure is a catchable `Error` carrying a **stable `code` property** —
codes, not message prose, are the API (messages may change freely; codes are
append-only). The contract is
[`specs/api/projector-napi.md`](../specs/api/projector-napi.md) § Error
contract, extending [`specs/api/errors.md`](../specs/api/errors.md).

Projector-level codes:

| Code | Raised when |
| --- | --- |
| `CONFIG` | A `.holo/` TOML file is malformed or semantically invalid. |
| `SOURCE_RESOLUTION` | A holosource resolved to no commit (gitlink → spec-ref → local ref). Often means the source simply isn't fetched. |
| `SOURCE_FETCH` | A remote source fetch failed (network, auth, unknown remote ref) — distinct from `SOURCE_RESOLUTION`. |
| `CIRCULAR_DEPENDENCY` | Mapping `before`/`after` constraints form a cycle. |
| `LENSED_SUBPROJECTION` | A recursive sub-projection would lens; the composition-only path refuses rather than silently skipping the lens. |
| `LENS_CONFIG` | A lens spec (`.holo/lenses/*.toml`) is malformed or semantically invalid. |
| `LENS_IDENTITY` | The lens container identity could not be resolved. |
| `LENS_PROTOCOL` | The lens image cannot run on this engine (e.g. a v1-protocol image). |
| `LENS_FAILED` | The lens job ran and failed — carries the inner transform's real exit code, failing phase, and captured log. |
| `LENS_TRANSPORT` | The lens job's result never arrived (container/exec plumbing), distinct from the lens tool failing. |
| `LENS_TIMEOUT` | The lens job exceeded its deadline and was cancelled. |
| `PROJECTION` | Residual projection failure not classified above. |

Underlying git failures forward the
[holo-tree codes](../specs/api/errors.md) unchanged — `GIT`,
`OBJECT_NOT_FOUND`, `NOT_A_TREE`, `REF_CONFLICT` (a `commitProjection`
compare-and-swap lost to a concurrent writer), … — plus `INVALID_ARGUMENT`
(bad hex id) at the marshalling layer and `INTERNAL` / `PANIC` (always an
engine bug — report it; the process stays healthy).

## Performance — release builds only

> **⚠️ Never benchmark or ship a debug build.** The published npm prebuilds
> are release builds — `npm install` users are fine. But if you build from
> source, `napi build` *without* `--release` produces a debug binary that is
> drastically slower than the JS engine it replaces, silently inverting the
> entire performance story. Always build with `npm run build`
> (`napi build --platform --release`).

Reference workload (the codeforphilly.org `emergence-site` holobranch:
~3,000 tree writes, 9 recursive sub-projections): a one-shot composition
runs in ~110–130ms; a warm `ProjectionSession` brings repeat projections to
~27ms, versus multiple seconds for the JS engine on the same input.

## Surface

| Export | Returns | Notes |
| --- | --- | --- |
| `compositeBranch(gitDir, rootTree, holobranch)` | tree hash | pre-lens composed tree (`.holo/config.toml` + `.holo/lenses` retained) |
| `projectBranch(gitDir, rootTree, holobranch)` | tree hash | full composition-only projection, metadata stripped |
| `projectPlan(gitDir, sources, mappings)` | tree hash | structured-config composition; no `.holo/` needed |
| `new ProjectionSession(gitDir)` | session | warm context; same three methods without `gitDir` |
| `session.commitProjection(options)` | commit hash | projection commit + compare-and-swap ref advance |
| `session.cachedTrees()` / `session.clearCache()` | — | cache observability / memory valve |
| `stats()` / `resetStats()` | counters | process-global metrics (trees read/written, cache hits, …) |

The binding is a deliberately thin marshalling shell: rough edges are fixed
upstream in the `holo-projector` crate, never papered over here
(`specs/principles.md`). New capability requests belong against the crate.

## Building

Requires a Rust toolchain and `@napi-rs/cli` (a devDependency):

```sh
npm install
npm run build         # release — use this for anything you'll measure or ship
npm run build:debug   # faster compile for development, runs SLOW (see Performance)
npm test              # node --test against scratch git repos (requires a built addon)
```

`napi build` emits `holo-projector.<triple>.node`. The generated `index.js`
loader and `index.d.ts` types **are committed**; only the `.node` binaries
are git-ignored (built per-platform in CI).

From the hologit repo root, `npm run build:projector-addon` does the
install + release build in one step — this is how the CLI's in-repo copy is
built (and what `test-cli` CI uses).

## Publishing

Published as the scoped package **`@hologit/holo-projector`** with
per-platform prebuilt binaries shipped as `optionalDependencies`:

| Platform package | Triple | Built on | Smoke-tested |
| --- | --- | --- | --- |
| `@hologit/holo-projector-linux-x64-gnu` | `x86_64-unknown-linux-gnu` | ubuntu-latest | ✓ native |
| `@hologit/holo-projector-linux-arm64-gnu` | `aarch64-unknown-linux-gnu` | ubuntu-24.04-arm | ✓ native |
| `@hologit/holo-projector-linux-x64-musl` | `x86_64-unknown-linux-musl` | ubuntu-latest (musl cross) | build-only |
| `@hologit/holo-projector-darwin-arm64` | `aarch64-apple-darwin` | macos-latest | ✓ native |
| `@hologit/holo-projector-darwin-x64` | `x86_64-apple-darwin` | macos-latest (cross) | build-only |
| `@hologit/holo-projector-win32-x64-msvc` | `x86_64-pc-windows-msvc` | windows-latest | ✓ native |

Native targets build + smoke-test on a matching runner; cross targets (musl,
darwin-x64) build only, since their `.node` can't run on the host arch/libc
(the logic is covered by the native runs). The
`.github/workflows/holo-projector-napi.yml` workflow builds all six on every
PR touching the binding or either engine crate, and on a
`holo-projector-v*` tag it builds then publishes.

Auth is **npm trusted publishing (OIDC)** — no tokens, matching hologit's
`publish-npm.yml`. Trusted publishing is configured *per package*, and a
package can't get a trusted publisher until it exists — so the packages need
a **one-time manual bootstrap** before automated releases work.

### One-time bootstrap (manual first publish, then configure trusted publishing)

The packages all start at an early version (currently `0.0.1`). They must
exist on npm before trusted publishing can be turned on.

1. **Get the prebuilt binaries.** Run the `holo-projector-napi` workflow
   (push the branch / open a PR, or trigger `workflow_dispatch`) and download
   its `bindings-*` artifacts — they hold the `.node` for each platform. A
   single machine can't build all of them natively, so use the CI artifacts.

2. **Publish all packages manually**, logged in as an `@hologit` org member
   (`npm login`):

   ```sh
   cd holo-projector-napi
   npm install
   npx napi artifacts --dir <downloaded-artifacts-dir>   # → npm/<triple>/*.node
   # platform packages first, then the main package:
   for d in npm/*/ ; do ( cd "$d" && npm publish --access public ); done
   npm publish --access public --ignore-scripts          # main; skip the napi
                                                         # prepublish hook
   ```

3. **Turn on trusted publishing** on npmjs.com for **each** of the packages
   → Settings → Trusted Publisher → GitHub Actions, repo
   `JarvusInnovations/hologit`, workflow `holo-projector-napi.yml`.

### Releases (after bootstrap — fully automated, tokenless)

```sh
git tag holo-projector-v0.1.1 && git push origin holo-projector-v0.1.1
```

The tag drives the published version; CI builds all platforms, then
publishes via OIDC (provenance). No secret needed. The `holo-projector-v*`
tag is the release marker — napi runs with `--skip-gh-release` so it does
**not** create a bare `v<version>` GitHub release/tag. **Never tag this
binding with a bare `v*`** — that namespace belongs to the `hologit` JS
package (it matches `publish-npm.yml`'s trigger and the develop→master
Release-PR flow).

To add or drop a platform later, edit `napi.triples.additional` +
`optionalDependencies` in `package.json`, run `napi create-npm-dir -t .`, add
the matching matrix entry in the workflow, and (since it's a new package)
bootstrap + trust that one package too.
