// Error-contract tests for the holo-tree-napi binding (specs/api/errors.md).
//
// Every failure must surface as a catchable JS Error whose `code` property
// carries a stable code from the contract — tests assert on codes, never on
// message prose. The panic-containment test proves that a Rust panic becomes
// a catchable `PANIC` error instead of aborting the host process (the
// `fatal runtime error: failed to initiate panic` failure mode of gitsheets
// finding #6).
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
const { Repo, __triggerPanicForTest } = require('../index.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'holo-tree-napi-errors-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'second');
  return dir;
}

/** Assert `fn` throws a real Error carrying exactly `code`. */
function assertThrowsCode(fn, code) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, `expected a thrown Error for ${code}`);
  assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

test('a Rust panic surfaces as a catchable PANIC error, not a process abort', () => {
  const err = assertThrowsCode(() => __triggerPanicForTest(), 'PANIC');
  assert.match(err.message, /panic/i);

  // The whole point: the process survives and the binding keeps working.
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const tree = repo.createTreeFromRef('HEAD');
    tree.writeChild('post-panic.txt', 'still alive\n');
    assert.match(tree.write(), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare-and-swap updateRef loss surfaces as REF_CONFLICT', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const head = repo.resolveRef('HEAD');
    const parent = repo.resolveRef('HEAD~1');

    // Ref is at `head`, but we claim it should still be at `parent`.
    git(dir, 'update-ref', 'refs/heads/work', head);
    assertThrowsCode(
      () => repo.updateRef('refs/heads/work', parent, parent),
      'REF_CONFLICT',
    );
    // CAS against a ref that doesn't exist at all is also a conflict.
    assertThrowsCode(
      () => repo.updateRef('refs/heads/ghost', head, parent),
      'REF_CONFLICT',
    );
    // The ref was not clobbered by the failed swaps.
    assert.equal(repo.resolveRef('refs/heads/work'), head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed caller input surfaces as INVALID_ARGUMENT', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));

    // Non-hex object id (binding-level marshalling).
    assertThrowsCode(() => repo.updateRef('refs/heads/x', 'not-a-hash'), 'INVALID_ARGUMENT');

    // Unknown merge mode (binding-level marshalling).
    const a = repo.createTree();
    const b = repo.createTree();
    assertThrowsCode(() => a.merge(b, { mode: 'sideways' }), 'INVALID_ARGUMENT');

    // Valid hash pointing at a non-blob object (crate-level classification).
    const tree = repo.createTreeFromRef('HEAD');
    tree.writeChild('dir/file.txt', 'x\n');
    const treeHash = tree.write();
    const reread = repo.createTreeFromRef(repo.commitTree(treeHash, [], 'tmp'));
    const dirHash = reread.getChild('dir').hash;
    assertThrowsCode(() => reread.writeChildHash('y', dirHash, 0o100644), 'INVALID_ARGUMENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hash absent from the ODB surfaces as OBJECT_NOT_FOUND', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const tree = repo.createTree();
    assertThrowsCode(
      () => tree.writeChildHash('x', '0123456789abcdef0123456789abcdef01234567', 0o100644),
      'OBJECT_NOT_FOUND',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing through a blob path component surfaces as NOT_A_TREE', () => {
  const dir = scratchRepo();
  try {
    const repo = Repo.open(join(dir, '.git'));
    const tree = repo.createTree();
    tree.writeChild('a/b', 'blob here\n');
    assertThrowsCode(() => tree.writeChild('a/b/c', 'nope\n'), 'NOT_A_TREE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unopenable repository surfaces as GIT', () => {
  assertThrowsCode(() => Repo.open('/nonexistent/definitely/not/a/repo'), 'GIT');
});
