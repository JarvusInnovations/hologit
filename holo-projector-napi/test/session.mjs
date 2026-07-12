// ProjectionSession tests: warm-context reuse, the staleness contract, and
// commitProjection (specs/api/projector-napi.md § ProjectionSession,
// specs/behaviors/watch.md § Warm session and staleness).
//
// The staleness tests are the load-bearing ones: they advance refs and write
// objects *behind an open session* via the external git CLI and assert the
// next call observes them — serving stale state would be a correctness bug,
// not a performance trade-off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../index.js');
} catch (err) {
  throw new Error(
    `holo-projector-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const { ProjectionSession, compositeBranch, stats } = binding;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(dir, path, content) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** A workspace whose `site` holobranch maps the self-source plus a
 * ref-resolved sibling source (`dep`, pinned to refs/heads/dep in the same
 * repository) — the ref is what the staleness tests advance. */
function scratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'holo-projector-session-'));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');

  // dep branch: content the site holobranch pulls in by ref
  write(dir, 'dep-file.txt', 'dep v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dep v1');
  git(dir, 'branch', 'dep');
  git(dir, 'rm', '-q', 'dep-file.txt');

  write(dir, '.holo/config.toml', '[holospace]\nname = "myapp"\n');
  write(dir, '.holo/sources/dep.toml', '[holosource]\nurl = "."\nref = "refs/heads/dep"\n');
  write(dir, '.holo/branches/site/_myapp.toml', '[holomapping]\nfiles = "**"\n');
  write(dir, '.holo/branches/site/vendor/_dep.toml', '[holomapping]\nfiles = "**"\n');
  write(dir, 'index.html', '<html>\n');

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'workspace');
  return dir;
}

function rootTree(dir, ref = 'HEAD') {
  return git(dir, 'rev-parse', `${ref}^{tree}`);
}

function lsTree(dir, hash) {
  const out = git(dir, 'ls-tree', '-r', '--name-only', hash);
  return out ? out.split('\n') : [];
}

test('session projections match one-shot projections and reuse the cache', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);
  const root = rootTree(dir);

  const oneShot = compositeBranch(dir, root, 'site');
  const first = session.compositeBranch(root, 'site');
  assert.equal(first, oneShot, 'session output must be hash-identical to one-shot');

  const cached = session.cachedTrees();
  assert.ok(cached > 0, `first call should populate the TreeCache (got ${cached})`);

  const hitsBefore = stats().cacheHits;
  const second = session.compositeBranch(root, 'site');
  assert.equal(second, first, 'repeat projection must be hash-identical');
  assert.ok(
    stats().cacheHits > hitsBefore,
    'repeat projection should hit the warm TreeCache',
  );

  session.clearCache();
  assert.equal(session.cachedTrees(), 0, 'clearCache drops all entries');
  assert.equal(
    session.compositeBranch(root, 'site'),
    first,
    'a cleared cache is a warmth loss, never a behavior change',
  );
});

test('a ref advanced behind the session is observed by the next call', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);
  const root = rootTree(dir);

  const before = session.compositeBranch(root, 'site');
  assert.ok(lsTree(dir, before).includes('vendor/dep-file.txt'));

  // Advance refs/heads/dep behind the open session with the external git
  // CLI: new commit objects land in the ODB and the ref moves, all without
  // the session's involvement.
  git(dir, 'switch', '-q', 'dep');
  write(dir, 'dep-file-2.txt', 'dep v2\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dep v2');
  git(dir, 'switch', '-q', 'master');

  const after = session.compositeBranch(root, 'site');
  assert.notEqual(after, before, 'advanced source ref must change the output');
  assert.ok(
    lsTree(dir, after).includes('vendor/dep-file-2.txt'),
    'output must include content only reachable from the advanced ref',
  );
});

test('objects written behind the session are visible without reopening', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);
  session.compositeBranch(rootTree(dir), 'site'); // warm the session first

  // New root commit written by the external git CLI after the session opened.
  write(dir, 'new-page.html', '<html>new</html>\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'add page');

  const out = session.compositeBranch(rootTree(dir), 'site');
  assert.ok(
    lsTree(dir, out).includes('new-page.html'),
    'projection from externally written objects must succeed and include them',
  );
});

test('commitProjection creates the specced commit and advances the ref', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);
  const root = rootTree(dir);
  const tree = session.projectBranch(root, 'site');
  const sourceCommit = git(dir, 'rev-parse', 'HEAD');

  const sig = { name: 'Holo Test', email: 'holo@example.com', timeSeconds: 1700000000, offsetMinutes: 0 };
  const commit = session.commitProjection({
    commitRef: 'projected',
    holobranch: 'site',
    tree,
    sourceCommit,
    sourceDescription: 'v1-test-describe',
    author: sig,
    committer: sig,
  });

  assert.equal(git(dir, 'rev-parse', 'refs/heads/projected'), commit, 'bare name normalizes to refs/heads/ and advances');
  assert.equal(git(dir, 'rev-parse', `${commit}^{tree}`), tree);

  // First parent is a fresh init commit (ref was absent), second the source.
  const parents = git(dir, 'log', '-1', '--format=%P', commit).split(' ');
  assert.equal(parents.length, 2);
  assert.equal(parents[1], sourceCommit);
  assert.equal(git(dir, 'log', '-1', '--format=%s', parents[0]), '↥ initialized site');

  const message = git(dir, 'log', '-1', '--format=%B', commit);
  assert.equal(
    message,
    `☀ projected site from v1-test-describe\n\nSource-holobranch: site\nSource-commit: ${sourceCommit}\nSource: v1-test-describe`,
  );

  // Second cycle: previous projection commit becomes the first parent.
  const commit2 = session.commitProjection({
    commitRef: 'projected',
    holobranch: 'site',
    tree,
    sourceCommit,
    sourceDescription: 'v1-test-describe',
    author: sig,
    committer: sig,
  });
  assert.equal(git(dir, 'log', '-1', '--format=%P', commit2).split(' ')[0], commit);
  assert.equal(git(dir, 'rev-parse', 'refs/heads/projected'), commit2);
});

test('commitProjection work-tree mode carries only the holobranch trailer', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);
  const tree = session.projectBranch(rootTree(dir), 'site');
  const sig = { name: 'Holo Test', email: 'holo@example.com', timeSeconds: 1700000000, offsetMinutes: 0 };

  const commit = session.commitProjection({
    commitRef: 'refs/heads/projected-wt',
    holobranch: 'site',
    tree,
    workTreePath: '/work/tree/path',
    author: sig,
    committer: sig,
  });

  const message = git(dir, 'log', '-1', '--format=%B', commit);
  assert.equal(message, '☀ projected site from /work/tree/path\n\nSource-holobranch: site');
});

test('commitProjection requires exactly one provenance input', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);
  const tree = session.projectBranch(rootTree(dir), 'site');
  const base = { commitRef: 'refs/heads/x', holobranch: 'site', tree };

  for (const options of [
    base,
    { ...base, sourceDescription: 'd', workTreePath: '/p' },
  ]) {
    assert.throws(
      () => session.commitProjection(options),
      (err) => err.code === 'INVALID_ARGUMENT',
      'zero or two provenance inputs must raise INVALID_ARGUMENT',
    );
  }
});

test('session errors carry stable codes', (t) => {
  const dir = scratchWorkspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const session = new ProjectionSession(dir);

  assert.throws(
    () => session.compositeBranch('not-a-hash', 'site'),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(() => new ProjectionSession(join(dir, 'nope')), (err) => err.code === 'GIT');
});
