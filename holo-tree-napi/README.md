# holo-tree-napi

Node.js native binding for [`holo-tree`](../holo-tree) — mutable in-memory git
trees via [gitoxide](https://github.com/GitoxideLabs/gitoxide), with no `git`
subprocess.

This crate exposes the narrow slice of holo-tree that record-oriented consumers
(notably [gitsheets](https://github.com/JarvusInnovations/gitsheets)) need for an
upsert→commit path. It is intentionally a thin pass-through; it is also the first
integrated consumer of the new Rust libs, so it doubles as a hardening vehicle —
rough edges in holo-tree's API are recorded as `Phase-C finding` notes in the
source and fixed upstream rather than worked around here.

## API

```js
const { Repo, emptyTreeHash } = require('@hologit/holo-tree');

const repo = Repo.open('/path/to/repo/.git');

const tree = repo.createTreeFromRef('HEAD'); // or repo.createTree() for empty
tree.writeChild('data/widgets/1.toml', 'id = 1\n'); // hash blob + deep insert
const treeHash = tree.write(); // flush dirty subtrees → ODB, returns tree hash

const commit = repo.commitTree(treeHash, [parentHash], 'add widget 1');
repo.updateRef('refs/heads/main', commit);

const bytes = repo.createTreeFromRef(commit).readBlob('data/widgets/1.toml');
```

Conventions: object ids cross the boundary as lowercase 40-char hex strings;
blob content crosses as `Buffer` (binary-safe).

### Surface

| Method | holo-tree call | Notes |
|---|---|---|
| `Repo.open(gitDir)` | `gix::open().into_sync()` | factory |
| `repo.createTreeFromRef(ref)` → `Tree` | `repo::create_tree_from_ref` | resolves ref→commit→tree |
| `repo.createTree()` → `Tree` | `MutableTree::empty` | |
| `repo.commitTree(treeHash, parents[], msg)` → hash | `repo::commit_tree` | uses git-config identity |
| `repo.updateRef(ref, hash)` | `repo::update_ref` | |
| `tree.writeChild(path, text)` → hash | `MutableTree::write_child` | UTF-8 text |
| `tree.writeChildBytes(path, buf)` → hash | `MutableTree::write_child_bytes` | binary |
| `tree.readBlob(path)` → `Buffer\|null` | `MutableTree::read_blob` | |
| `tree.deleteChildDeep(path)` → bool | `MutableTree::delete_child_deep` | |
| `tree.write()` → treeHash | `MutableTree::write` | |
| `emptyTreeHash()` → hash | `tree::empty_tree_id` | module fn |

## Building

Requires a Rust toolchain and `@napi-rs/cli` (a devDependency):

```sh
npm install
npm run build:debug   # or: npm run build   (release)
npm test              # node --test against a scratch git repo
```

`napi build` emits `holo-tree.<triple>.node`. The generated `index.js` loader
and `index.d.ts` types **are committed**; only the `.node` binaries are
git-ignored (built per-platform in CI).

## Publishing

Published as the scoped package **`@hologit/holo-tree`** with per-platform
prebuilt binaries shipped as `optionalDependencies`:

| Platform package | Triple | Built on |
| --- | --- | --- |
| `@hologit/holo-tree-linux-x64-gnu` | `x86_64-unknown-linux-gnu` | ubuntu-latest |
| `@hologit/holo-tree-darwin-arm64` | `aarch64-apple-darwin` | macos-latest |
| `@hologit/holo-tree-win32-x64-msvc` | `x86_64-pc-windows-msvc` | windows-latest |

Each target builds **natively** on its runner — no cross-compilation. The
`.github/workflows/holo-tree-napi.yml` workflow builds + smoke-tests all three on
every PR touching the binding, and on a `holo-tree-v*` tag it builds then
publishes.

Auth is **npm trusted publishing (OIDC)** — no tokens, matching hologit's
`publish-npm.yml`. Trusted publishing is configured *per package*, and a package
can't get a trusted publisher until it exists — so the four packages need a
**one-time manual bootstrap** before automated releases work.

### One-time bootstrap (manual first publish, then configure trusted publishing)

The four packages all start at an early version (currently `0.0.1`). They must
exist on npm before trusted publishing can be turned on.

1. **Get the prebuilt binaries.** Run the `holo-tree-napi` workflow (push the
   branch / open a PR, or trigger `workflow_dispatch`) and download its three
   `bindings-*` artifacts — they hold the `.node` for each platform. A single
   machine can't build all three natively, so use the CI artifacts.

2. **Publish all four manually**, logged in as an `@hologit` org member
   (`npm login`):

   ```sh
   cd holo-tree-napi
   npm install
   npx napi artifacts --dir <downloaded-artifacts-dir>   # → npm/<triple>/*.node
   # platform packages first, then the main package:
   for d in npm/*/ ; do ( cd "$d" && npm publish --access public ); done
   npm publish --access public --ignore-scripts          # main; skip the napi
                                                         # prepublish GH-release hook
   ```

3. **Turn on trusted publishing** on npmjs.com for **each** of the four packages
   → Settings → Trusted Publisher → GitHub Actions, repo
   `JarvusInnovations/hologit`, workflow `holo-tree-napi.yml`.

### Releases (after bootstrap — fully automated, tokenless)

```sh
git tag holo-tree-v0.1.0 && git push origin holo-tree-v0.1.0
```

The tag drives the published version; CI builds all three platforms, then
publishes via OIDC (provenance + a GitHub release). No secret needed.

To add or drop a platform later, edit `napi.triples.additional` +
`optionalDependencies` in `package.json`, run `napi create-npm-dir -t .`, add the
matching matrix entry in the workflow, and (since it's a new package) bootstrap

+ trust that one package too.
