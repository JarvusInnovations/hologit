// Error-contract tests for the holo-projector-napi binding
// (specs/api/projector-napi.md, extending specs/api/errors.md).
//
// Every failure must surface as a catchable JS Error whose `code` property
// carries a stable code — tests assert on codes, never on message prose.
// The panic-containment test proves that a Rust panic becomes a catchable
// `PANIC` error instead of aborting the host process.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compositeBranch, projectBranch, projectPlan, __triggerPanicForTest } = require('../index.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(dir, path, content) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function scratchRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'holo-projector-napi-errors-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  for (const [path, content] of Object.entries(files)) {
    write(dir, path, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
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
  const dir = scratchRepo({
    '.holo/config.toml': '[holospace]\nname = "app"\n',
    '.holo/branches/site/_app.toml': '[holomapping]\nfiles = "**"\n',
    'index.html': '<html>\n',
  });
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    assert.match(projectBranch(join(dir, '.git'), head, 'site'), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unopenable repo surfaces as GIT', () => {
  assertThrowsCode(
    () => projectBranch('/nonexistent/definitely-not-a-repo/.git', '0'.repeat(40), 'site'),
    'GIT',
  );
});

test('malformed object id surfaces as INVALID_ARGUMENT', () => {
  const dir = scratchRepo({ 'a.txt': 'a\n' });
  try {
    assertThrowsCode(
      () => projectBranch(join(dir, '.git'), 'not-a-hash', 'site'),
      'INVALID_ARGUMENT',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unresolvable holosource surfaces as SOURCE_RESOLUTION', () => {
  const dir = scratchRepo({
    '.holo/config.toml': '[holospace]\nname = "app"\n',
    '.holo/sources/missing.toml': '[holosource]\nref = "refs/heads/nope"\n',
    '.holo/branches/site/_missing.toml': '[holomapping]\nfiles = "**"\n',
    'index.html': '<html>\n',
  });
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    assertThrowsCode(
      () => projectBranch(join(dir, '.git'), head, 'site'),
      'SOURCE_RESOLUTION',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed holomapping surfaces as CONFIG', () => {
  const dir = scratchRepo({
    '.holo/config.toml': '[holospace]\nname = "app"\n',
    // holomapping with no `files` is a config error
    '.holo/branches/site/_app.toml': '[holomapping]\n',
    'index.html': '<html>\n',
  });
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    assertThrowsCode(() => projectBranch(join(dir, '.git'), head, 'site'), 'CONFIG');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lensed sub-projection is refused with LENSED_SUBPROJECTION', () => {
  // `site` maps `app=>sub` — a self-source recursion into holobranch `sub`,
  // which carries an external lens config and no explicit lens=false.
  const dir = scratchRepo({
    '.holo/config.toml': '[holospace]\nname = "app"\n',
    '.holo/branches/site/_app.toml': '[holomapping]\nholosource = "=>sub"\nfiles = "**"\n',
    '.holo/branches/sub/_app.toml': '[holomapping]\nfiles = "**"\n',
    '.holo/branches/sub.lenses/build.toml': '[hololens]\ncontainer = "example/build:latest"\n',
    'index.html': '<html>\n',
  });
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const err = assertThrowsCode(
      () => compositeBranch(join(dir, '.git'), head, 'site'),
      'LENSED_SUBPROJECTION',
    );
    assert.ok(err.message.includes('sub'), 'names the offending holobranch');

    // With the sub-branch explicitly opted out of lensing, composition proceeds.
    write(dir, '.holo/branches/sub.toml', '[holobranch]\nlens = false\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'opt out of lensing');
    const head2 = git(dir, 'rev-parse', 'HEAD');
    assert.match(compositeBranch(join(dir, '.git'), head2, 'site'), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('circular mapping constraints surface as CIRCULAR_DEPENDENCY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-projector-napi-cycle-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    write(dir, 'a.txt', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'branch', 'data');

    assertThrowsCode(
      () =>
        projectPlan(
          join(dir, '.git'),
          [{ name: 'src', ref: 'refs/heads/data' }],
          [
            { source: 'src', layer: 'a', after: ['b'] },
            { source: 'src', layer: 'b', after: ['a'] },
          ],
        ),
      'CIRCULAR_DEPENDENCY',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
