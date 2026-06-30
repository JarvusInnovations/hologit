// Smoke tests for the tree/ref ops added for the gitsheets migration:
//   writeBlob, resolveRef, updateRef (CAS), getChild, getChildren,
//   getBlobMap, clearChildren, merge.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../index.js');
} catch (err) {
  throw new Error(
    `holo-tree-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const { Repo } = binding;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'holo-tree-napi-ops-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
}

test('writeBlob hashes bytes without touching any tree', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const hash = repo.writeBlob(Buffer.from('hello\n'));
    assert.match(hash, /^[0-9a-f]{40}$/);
    // Parity oracle: git's own object hash for the same content.
    const oracle = execFileSync('git', ['hash-object', '-t', 'blob', '--stdin'], {
      cwd: dir,
      input: 'hello\n',
      encoding: 'utf8',
    }).trim();
    assert.equal(hash, oracle, 'writeBlob must match git hash-object');
    // And the object is actually present in the ODB.
    assert.equal(git(dir, 'cat-file', '-p', hash), 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRef resolves branches and returns null for unknown refs', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const branchRef = git(dir, 'symbolic-ref', 'HEAD');
    const head = git(dir, 'rev-parse', 'HEAD');

    assert.equal(repo.resolveRef(branchRef), head);
    assert.equal(repo.resolveRef('HEAD'), head);
    assert.equal(repo.resolveRef('refs/heads/does-not-exist'), null);
    assert.equal(repo.resolveRef('totally-bogus'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateRef compare-and-swap: succeeds on match, rejects on mismatch', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const branchRef = git(dir, 'symbolic-ref', 'HEAD');
    const c1 = git(dir, 'rev-parse', 'HEAD');

    // Build C2 (child of C1).
    const t2 = repo.createTreeFromRef('HEAD');
    t2.writeChild('a.toml', 'id = 1\n');
    const c2 = repo.commitTree(t2.write(), [c1], 'c2');

    // CAS from C1 → C2 succeeds.
    repo.updateRef(branchRef, c2, c1);
    assert.equal(repo.resolveRef(branchRef), c2);

    // Build C3 (child of C2).
    const t3 = repo.createTreeFromRef(c2);
    t3.writeChild('b.toml', 'id = 2\n');
    const c3 = repo.commitTree(t3.write(), [c2], 'c3');

    // CAS claiming the ref is still at C1 must fail (it's at C2 now).
    assert.throws(() => repo.updateRef(branchRef, c3, c1), /.*/);
    assert.equal(repo.resolveRef(branchRef), c2, 'ref must be unchanged after a failed CAS');

    // Force (no expected) succeeds.
    repo.updateRef(branchRef, c3);
    assert.equal(repo.resolveRef(branchRef), c3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getChild / getChildren navigate read-only', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const tree = repo.createTree();
    const blobHash = tree.writeChild('data/widgets/1.toml', 'id = 1\n');
    tree.writeChild('data/widgets/2.toml', 'id = 2\n');
    tree.write();

    // Deep blob lookup.
    const child = tree.getChild('data/widgets/1.toml');
    assert.ok(child);
    assert.equal(child.type, 'blob');
    assert.equal(child.hash, blobHash);
    assert.equal(child.mode, 0o100644);

    // Subtree lookup.
    const sub = tree.getChild('data/widgets');
    assert.equal(sub.type, 'tree');

    // Missing path.
    assert.equal(tree.getChild('data/widgets/nope.toml'), null);

    // Direct children of a subtree.
    const names = tree.getChildren('data/widgets').map((c) => c.name).sort();
    assert.deepEqual(names, ['1.toml', '2.toml']);
    assert.ok(tree.getChildren('data/widgets').every((c) => c.type === 'blob'));

    // Missing subtree → empty.
    assert.deepEqual(tree.getChildren('data/gadgets'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getBlobMap flattens a subtree, paths relative to it', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const tree = repo.createTree();
    tree.writeChild('data/widgets/1.toml', 'id = 1\n');
    tree.writeChild('data/widgets/2.toml', 'id = 2\n');
    tree.writeChild('README.md', 'hi\n');
    tree.write();

    const all = tree.getBlobMap().map((b) => b.path).sort();
    assert.deepEqual(all, ['README.md', 'data/widgets/1.toml', 'data/widgets/2.toml']);

    const scoped = tree.getBlobMap('data/widgets').map((b) => b.path).sort();
    assert.deepEqual(scoped, ['1.toml', '2.toml'], 'paths are relative to the navigated subtree');

    assert.deepEqual(tree.getBlobMap('data/missing'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearChildren wipes a subtree but preserves siblings', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const tree = repo.createTree();
    tree.writeChild('data/widgets/1.toml', 'id = 1\n');
    tree.writeChild('data/gadgets/9.toml', 'id = 9\n');
    tree.writeChild('README.md', 'hi\n');
    tree.write();

    tree.clearChildren('data/widgets');
    tree.writeChild('data/widgets/fresh.toml', 'id = 3\n');
    tree.write();

    const paths = tree.getBlobMap().map((b) => b.path).sort();
    assert.deepEqual(paths, [
      'README.md',
      'data/gadgets/9.toml',
      'data/widgets/fresh.toml',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge overlays another tree in place', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));

    const base = repo.createTree();
    base.writeChild('a.toml', 'base-a\n');
    base.writeChild('shared.toml', 'base-shared\n');
    base.write();

    const incoming = repo.createTree();
    incoming.writeChild('shared.toml', 'incoming-shared\n');
    incoming.writeChild('b.toml', 'incoming-b\n');
    incoming.write();

    base.merge(incoming, { mode: 'overlay' });
    base.write();

    const map = Object.fromEntries(base.getBlobMap().map((b) => [b.path, b.hash]));
    assert.deepEqual(Object.keys(map).sort(), ['a.toml', 'b.toml', 'shared.toml']);

    // shared.toml must now hold the incoming content's hash.
    const incomingShared = incoming.getChild('shared.toml').hash;
    assert.equal(map['shared.toml'], incomingShared, 'overlay must overwrite shared.toml');

    // An invalid mode is rejected.
    assert.throws(() => base.merge(incoming, { mode: 'bogus' }), /invalid merge mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
