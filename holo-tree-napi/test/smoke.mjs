// Smoke test for the holo-tree-napi binding.
//
// Exercises the full upsert→commit vertical slice against a scratch repo:
//   open → createTreeFromRef → writeChild → write → commitTree → updateRef
// then re-resolves the new commit and reads the blob back.
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
  // Surface a clear message rather than a cryptic MODULE_NOT_FOUND.
  throw new Error(
    `holo-tree-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const { Repo, emptyTreeHash } = binding;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'holo-tree-napi-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
}

test('emptyTreeHash matches git’s well-known empty tree', () => {
  assert.equal(emptyTreeHash(), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

test('upsert→commit round-trips and advances the ref', () => {
  const dir = scratchRepo();
  try {
    const branchRef = git(dir, 'symbolic-ref', 'HEAD'); // e.g. refs/heads/main
    const parent = git(dir, 'rev-parse', 'HEAD');

    const repo = Repo.open(join(dir, '.git'));

    // Build the new tree from HEAD and write one record.
    const tree = repo.createTreeFromRef('HEAD');
    const recordPath = 'data/widgets/1.toml';
    const recordBody = 'id = 1\nname = "widget"\n';
    tree.writeChild(recordPath, recordBody);
    const treeHash = tree.write();
    assert.match(treeHash, /^[0-9a-f]{40}$/);

    // Commit it and advance the branch.
    const commit = repo.commitTree(treeHash, [parent], 'add widget 1');
    assert.match(commit, /^[0-9a-f]{40}$/);
    repo.updateRef(branchRef, commit);

    // git agrees the ref moved to our commit, with the right tree.
    assert.equal(git(dir, 'rev-parse', 'HEAD'), commit);
    assert.equal(git(dir, 'rev-parse', `${commit}^{tree}`), treeHash);

    // Read the blob back through the binding from the committed tree.
    const reopened = repo.createTreeFromRef(commit);
    const bytes = reopened.readBlob(recordPath);
    assert.ok(bytes, 'blob should exist at the record path');
    assert.equal(Buffer.from(bytes).toString('utf8'), recordBody);

    // Parity oracle: git's own object content matches what we read.
    const fromGit = git(dir, 'cat-file', '-p', `${commit}:${recordPath}`);
    assert.equal(fromGit, recordBody.trimEnd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
