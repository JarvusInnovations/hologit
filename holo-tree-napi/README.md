# @hologit/holo-tree

Git tree, ref, blob, and commit primitives for Node.js — a native binding over
the [`holo-tree`](../holo-tree) Rust crate, powered by
[gitoxide](https://github.com/GitoxideLabs/gitoxide).

- **No `git` binary.** Everything runs in-process through gix; nothing shells
  out. Works anywhere Node runs, including environments with no git installed.
- **Bare-repo native.** Operates directly on git object databases and refs —
  no working directory, no index. A bare clone is a full-fledged store.
- **Mutable in-memory trees.** Load a tree from any ref, upsert/delete/merge
  paths against it in memory, then flush only the dirty subtrees to the ODB
  and commit — the natural substrate for record stores, content pipelines, and
  anything that treats a git repo as a database.
- **Built for embedding.** Stable machine-matchable error codes, panic
  containment at the FFI boundary (a Rust bug can never abort your process),
  and no reliance on thread-implicit state.

This package is a supported, standalone primitive — the Node-side consumption
mode of the same crate that Rust consumers (e.g.
[gitsheets](https://github.com/JarvusInnovations/gitsheets)) link directly via
Cargo. Both modes ship from `holo-tree-v*` tags and implement the same
contract (`specs/architecture.md` § Embedding consumers).

## Install

```sh
npm install @hologit/holo-tree
```

Prebuilt release binaries ship as `optionalDependencies` for:
linux-x64-gnu, linux-arm64-gnu, linux-x64-musl, darwin-arm64, darwin-x64,
win32-x64-msvc (full matrix under [Publishing](#publishing)). No Rust
toolchain needed on supported platforms.

## Quick start

```js
const { Repo, emptyTreeHash } = require('@hologit/holo-tree');

const repo = Repo.open('/path/to/repo.git'); // bare or .git dir

// load HEAD's tree, upsert a record, commit, advance the branch
const tree = repo.createTreeFromRef('HEAD'); // or repo.createTree() for empty
tree.writeChild('data/widgets/1.toml', 'id = 1\n'); // hash blob + deep insert
const treeHash = tree.write(); // flush dirty subtrees → ODB, returns tree hash

const parent = repo.resolveRef('HEAD');
const commit = repo.commitTree(treeHash, [parent], 'add widget 1');
repo.updateRef('refs/heads/main', commit, parent); // compare-and-swap

const bytes = repo.createTreeFromRef(commit).readBlob('data/widgets/1.toml');
```

Conventions: object ids cross the boundary as lowercase 40-char hex strings;
blob content crosses as `Buffer` (binary-safe).

## Errors: match on `code`, never on message

Every failure is a catchable `Error` carrying a **stable `code` property** —
codes, not message prose, are the API (messages may change freely). The
contract, including the full code table and stability rules, is
[`specs/api/errors.md`](../specs/api/errors.md).

```js
try {
  repo.updateRef('refs/heads/main', commit, expectedParent);
} catch (err) {
  switch (err.code) {
    case 'REF_CONFLICT': // someone else moved the ref — reload and retry
      return retryTransaction();
    case 'OBJECT_NOT_FOUND': // a hash you passed isn't in the ODB
      throw new StoreCorruptError(err.message);
    default:
      throw err;
  }
}
```

Common codes: `REF_CONFLICT` (lost a compare-and-swap `updateRef` — the
optimistic-concurrency signal), `OBJECT_NOT_FOUND`, `NOT_A_TREE`,
`PATH_NOT_FOUND`, `INVALID_ARGUMENT` (malformed hex id, bad merge mode, …),
`GIT` (unclassified git failure), `INTERNAL` / `PANIC` (always a holo-tree
bug — report it; the process stays healthy, but discard the involved objects).

Absence is a value, not an error: probes like `readBlob`, `getChild`, and
`resolveRef` return `null` for "not there".

## Performance — release builds only

> **⚠️ Never benchmark or ship a debug build.** The published npm prebuilds
> are release builds — `npm install` users are fine. But if you build from
> source, `napi build` *without* `--release` produces a debug binary measured
> **~2.4× slower** than the equivalent JS + `git` subprocess path on the
> reference workload, while the same code built with `--release`
> (`npm run build`) is **~4–5× faster**. A debug build silently inverts the
> entire performance story. Check at runtime with `buildProfile()`, which
> returns `'release'` or `'debug'` — the bundled benchmark refuses debug
> builds.

Reference workload (real data: an 18k-record flat tree — see
[`bench/`](bench/)): single-record upsert→commit ~25ms vs ~100ms for the JS
hologit + `git` subprocess path; 500 records in one commit ~41ms vs ~186ms.
Reproduce with:

```sh
npm run build && node bench/holo-tree-bench.mjs
```

## Thread safety

`Repo` is backed by a `gix::ThreadSafeRepository` and is safe to hold
anywhere. Each `Tree` owns its own tree cache, so behavior never depends on
which thread the JS engine dispatches a call on — at worst a thread switch
costs cache warmth, never correctness (`specs/api/errors.md` § Thread-safety
expectations). Objects are not shareable across `worker_threads` (each worker
must `Repo.open` its own handle); within one JS thread, calls are synchronous
and complete before returning.

## Surface

| Method | holo-tree call | Notes |
| --- | --- | --- |
| `Repo.open(gitDir)` | `gix::open().into_sync()` | factory; bare repo or `.git` dir |
| `repo.createTreeFromRef(ref)` → `Tree` | `repo::create_tree_from_ref` | resolves ref→commit→tree |
| `repo.createTree()` → `Tree` | `MutableTree::empty` | |
| `repo.commitTree(treeHash, parents[], msg, author?, committer?)` → hash | `repo::commit_tree` | identities fall back to git config |
| `repo.updateRef(ref, hash, expectedOldHash?)` | `repo::update_ref` | compare-and-swap when `expectedOldHash` given; force otherwise |
| `repo.resolveRef(ref)` → `hash\|null` | `repo::resolve_ref` | peels tags; `null` if unresolved |
| `repo.writeBlob(buf)` → hash | `gix write_blob` | hash bytes into the ODB, no tree |
| `tree.writeChild(path, text)` → hash | `MutableTree::write_child` | UTF-8 text |
| `tree.writeChildBytes(path, buf)` → hash | `MutableTree::write_child_bytes` | binary |
| `tree.writeChildHash(path, hash, mode)` → hash | `MutableTree::write_child_hash` | graft an existing ODB blob without re-hashing |
| `tree.readBlob(path)` → `Buffer\|null` | `MutableTree::read_blob` | |
| `tree.getChild(path)` → `{type,hash,mode}\|null` | `MutableTree::get_child` | read-only; deep path |
| `tree.getChildren(path)` → `[{name,type,hash,mode}]` | `get_subtree`+`ensure_children` | read-only; direct children |
| `tree.getBlobMap(path?)` → `[{path,hash,mode}]` | `get_subtree`+`get_blob_map` | read-only; paths relative to subtree |
| `tree.deleteChildDeep(path)` → bool | `MutableTree::delete_child_deep` | |
| `tree.clearChildren(path)` | `MutableTree::clear_children` | O(1) subtree wipe |
| `tree.merge(other, {files?, mode})` | `MutableTree::merge` | `mode`: `overlay`/`replace`/`underlay` |
| `tree.write()` → treeHash | `MutableTree::write` | flush dirty subtrees |
| `emptyTreeHash()` → hash | `tree::empty_tree_id` | module fn |
| `buildProfile()` → `'release'\|'debug'` | — | guard against debug builds |

`mode` values are the git filemode as a number (e.g. `33188` = `0o100644`).
Tree hashes reported by the read-only navigators reflect the last
`write()`/load and are stale for a subtree mutated since — flush with
`write()` for canonical hashes.

The binding is a deliberately thin marshalling shell: rough edges are fixed
upstream in the `holo-tree` crate, never papered over here
(`specs/principles.md`). New capability requests belong against the crate.

## Origins

This binding began as the integration vehicle for the gitsheets holo-tree
spike — the first embedded consumer of the Rust crates. The `Phase-C finding`
comments in the source record rough edges discovered during that hardening
pass, each fixed upstream in holo-tree (error codes, panic containment, the
consumer-owned tree cache). gitsheets has since moved to linking holo-tree
directly as a Cargo crate; this package continues as the supported Node-side
surface of the same crate.

## Building

Requires a Rust toolchain and `@napi-rs/cli` (a devDependency):

```sh
npm install
npm run build         # release — use this for anything you'll measure or ship
npm run build:debug   # debug — compile-fast, runs SLOW (see Performance)
npm test              # node --test against a scratch git repo
npm run bench         # release-build benchmark (refuses debug builds)
```

`napi build` emits `holo-tree.<triple>.node`. The generated `index.js` loader
and `index.d.ts` types **are committed**; only the `.node` binaries are
git-ignored (built per-platform in CI).

## Publishing

Published as the scoped package **`@hologit/holo-tree`** with per-platform
prebuilt binaries shipped as `optionalDependencies`:

| Platform package | Triple | Built on | Smoke-tested |
| --- | --- | --- | --- |
| `@hologit/holo-tree-linux-x64-gnu` | `x86_64-unknown-linux-gnu` | ubuntu-latest | ✓ native |
| `@hologit/holo-tree-linux-arm64-gnu` | `aarch64-unknown-linux-gnu` | ubuntu-24.04-arm | ✓ native |
| `@hologit/holo-tree-linux-x64-musl` | `x86_64-unknown-linux-musl` | ubuntu-latest (musl cross) | build-only |
| `@hologit/holo-tree-darwin-arm64` | `aarch64-apple-darwin` | macos-latest | ✓ native |
| `@hologit/holo-tree-darwin-x64` | `x86_64-apple-darwin` | macos-latest (cross) | build-only |
| `@hologit/holo-tree-win32-x64-msvc` | `x86_64-pc-windows-msvc` | windows-latest | ✓ native |

Native targets build + smoke-test on a matching runner; cross targets (musl,
darwin-x64) build only, since their `.node` can't run on the host arch/libc (the
logic is covered by the native runs). The `.github/workflows/holo-tree-napi.yml`
workflow builds all six on every PR touching the binding, and on a
`holo-tree-v*` tag it builds then publishes.

Auth is **npm trusted publishing (OIDC)** — no tokens, matching hologit's
`publish-npm.yml`. Trusted publishing is configured *per package*, and a package
can't get a trusted publisher until it exists — so the packages need a
**one-time manual bootstrap** before automated releases work.

### One-time bootstrap (manual first publish, then configure trusted publishing)

The packages all start at an early version (currently `0.0.1`). They must
exist on npm before trusted publishing can be turned on.

1. **Get the prebuilt binaries.** Run the `holo-tree-napi` workflow (push the
   branch / open a PR, or trigger `workflow_dispatch`) and download its
   `bindings-*` artifacts — they hold the `.node` for each platform. A single
   machine can't build all of them natively, so use the CI artifacts.

2. **Publish all packages manually**, logged in as an `@hologit` org member
   (`npm login`):

   ```sh
   cd holo-tree-napi
   npm install
   npx napi artifacts --dir <downloaded-artifacts-dir>   # → npm/<triple>/*.node
   # platform packages first, then the main package:
   for d in npm/*/ ; do ( cd "$d" && npm publish --access public ); done
   npm publish --access public --ignore-scripts          # main; skip the napi
                                                         # prepublish hook
   ```

3. **Turn on trusted publishing** on npmjs.com for **each** of the packages
   → Settings → Trusted Publisher → GitHub Actions, repo
   `JarvusInnovations/hologit`, workflow `holo-tree-napi.yml`.

### Releases (after bootstrap — fully automated, tokenless)

```sh
git tag holo-tree-v0.1.1 && git push origin holo-tree-v0.1.1
```

The tag drives the published version; CI builds all platforms, then
publishes via OIDC (provenance). No secret needed. The `holo-tree-v*` tag is the
release marker — napi runs with `--skip-gh-release` so it does **not** create a
bare `v<version>` GitHub release/tag (which would collide with hologit's own
`v*` JS-package release namespace). The same tag serves as the Cargo
git-dependency pin for Rust consumers of the `holo-tree` crate.

To add or drop a platform later, edit `napi.triples.additional` +
`optionalDependencies` in `package.json`, run `napi create-npm-dir -t .`, add the
matching matrix entry in the workflow, and (since it's a new package) bootstrap
- trust that one package too.
