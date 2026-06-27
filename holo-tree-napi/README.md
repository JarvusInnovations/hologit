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
const { Repo, emptyTreeHash } = require('holo-tree-napi');

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

`napi build` emits `holo-tree-napi.<triple>.node` plus generated `index.js` /
`index.d.ts` (all git-ignored — they are build artifacts).

## Status

Phase A of the gitsheets holo-tree spike (see
`plans/holo-tree-napi-spike.md` in the gitsheets repo). Not published to npm;
gitsheets consumes it via a local path/git dependency during the spike.
