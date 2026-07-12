// Smoke test for the holo-projector-napi binding.
//
// Builds a real .holo/ workspace in a scratch repo with the git CLI, then
// exercises the three projection entry points and verifies output shape via
// `git ls-tree` — the binding and the git CLI must agree about the ODB.
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

let binding;
try {
  binding = require('../index.js');
} catch (err) {
  throw new Error(
    `holo-projector-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const { compositeBranch, projectBranch, projectPlan } = binding;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(dir, path, content) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** A workspace whose `site` holobranch maps the whole self-source. */
function scratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'holo-projector-napi-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');

  write(dir, '.holo/config.toml', '[holospace]\nname = "myapp"\n');
  write(dir, '.holo/branches/site/_myapp.toml', '[holomapping]\nfiles = "**"\n');
  write(dir, 'index.html', '<html>\n');
  write(dir, 'docs/readme.md', '# docs\n');

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function lsTree(dir, hash) {
  const out = git(dir, 'ls-tree', '-r', '--name-only', hash);
  return out ? out.split('\n') : [];
}

test('projectBranch composes the self-source and strips .holo', () => {
  const dir = scratchWorkspace();
  try {
    const head = git(dir, 'rev-parse', 'HEAD'); // commit hash — binding peels to tree
    const hash = projectBranch(join(dir, '.git'), head, 'site');
    assert.match(hash, /^[0-9a-f]{40}$/);

    const paths = lsTree(dir, hash);
    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('docs/readme.md'));
    assert.ok(!paths.some((p) => p.startsWith('.holo/')), `.holo leaked: ${paths}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compositeBranch returns the pre-lens tree with .holo/config.toml retained', () => {
  const dir = scratchWorkspace();
  try {
    const gitDir = join(dir, '.git');
    const rootTree = git(dir, 'rev-parse', 'HEAD^{tree}'); // tree hash also accepted
    const preLens = compositeBranch(gitDir, rootTree, 'site');
    const full = projectBranch(gitDir, rootTree, 'site');

    const paths = lsTree(dir, preLens);
    assert.ok(paths.includes('.holo/config.toml'), 'pre-lens tree keeps .holo/config.toml');
    assert.ok(!paths.some((p) => p.startsWith('.holo/branches/')), 'branches stripped');
    assert.ok(paths.includes('index.html'));
    assert.notEqual(preLens, full, 'pre-lens tree differs from fully stripped projection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projectBranch is deterministic across calls and repo openings', () => {
  const dir = scratchWorkspace();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const first = projectBranch(join(dir, '.git'), head, 'site');
    const second = projectBranch(join(dir, '.git'), head, 'site');
    assert.equal(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projectPlan composes structured layers from local refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-projector-napi-plan-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');

    // Layer 1 on refs/heads/base
    write(dir, 'base.txt', 'base\n');
    write(dir, 'shared.txt', 'from base\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'branch', 'base');

    // Layer 2 on refs/heads/overlay
    rmSync(join(dir, 'base.txt'));
    write(dir, 'overlay.txt', 'overlay\n');
    write(dir, 'shared.txt', 'from overlay\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'overlay');
    git(dir, 'branch', 'overlay');

    const hash = projectPlan(
      join(dir, '.git'),
      [
        { name: 'base', ref: 'refs/heads/base' },
        { name: 'overlay', ref: 'refs/heads/overlay' },
      ],
      [
        { source: 'base' },
        { source: 'overlay', after: ['base'] },
      ],
    );

    const paths = lsTree(dir, hash);
    assert.ok(paths.includes('base.txt'));
    assert.ok(paths.includes('overlay.txt'));
    // Later layer wins the overlap
    const shared = git(dir, 'show', `${hash}:shared.txt`);
    assert.equal(shared, 'from overlay');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
