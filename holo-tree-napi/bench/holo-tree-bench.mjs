#!/usr/bin/env node
// Benchmark harness for @hologit/holo-tree.
//
// Canonical workload (the reference shape from the gitsheets spike: an
// 18k-record flat tree — see issue #464):
//
//   1. bulk-load N records into one flat directory, write, commit, advance ref
//   2. single-record upsert→commit against the big tree
//   3. 500-record batch upsert→commit
//   4. read paths: full getBlobMap, and repeated deep readBlob
//
// Usage:
//   npm run bench                 # requires a RELEASE build (npm run build)
//   node bench/holo-tree-bench.mjs --records 18000 --json
//   node bench/holo-tree-bench.mjs --allow-debug   # only to demo the penalty
//
// Debug builds are refused by default: a debug binding measures SLOWER than
// the JS + git-subprocess path it replaces (~2.4x on this workload), so any
// number it produces is disinformation. See README § Performance.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../index.js');
} catch (err) {
  console.error(`holo-tree-napi addon not built — run \`npm run build\` first.\n  cause: ${err.message}`);
  process.exit(1);
}
const { Repo } = binding;

const { values: opts } = parseArgs({
  options: {
    records: { type: 'string', default: process.env.HOLO_TREE_BENCH_RECORDS ?? '18000' },
    iterations: { type: 'string', default: '20' },
    json: { type: 'boolean', default: false },
    'allow-debug': { type: 'boolean', default: false },
  },
});
const N = Number(opts.records);
const ITERS = Number(opts.iterations);

// ── build-profile guard ─────────────────────────────────────────────────────

const profile = typeof binding.buildProfile === 'function' ? binding.buildProfile() : 'unknown';
if (profile !== 'release' && !opts['allow-debug']) {
  console.error(
    `refusing to benchmark a ${profile} build — its numbers invert the real story ` +
      '(debug is slower than the JS path this binding replaces).\n' +
      'Build with `npm run build` first, or pass --allow-debug to demo the penalty.',
  );
  process.exit(1);
}

// ── scratch repo ────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const dir = mkdtempSync(join(tmpdir(), 'holo-tree-bench-'));
git(dir, 'init', '-q', '--bare');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const repo = Repo.open(dir);
const REF = 'refs/heads/bench';
const SIG = { name: 'Bench', email: 'bench@example.com' };

const record = (i, rev = 0) =>
  `id = ${i}\nrev = ${rev}\nname = "Record ${i}"\nemail = "record-${i}@example.com"\nactive = ${i % 2 === 0}\n`;
const recordPath = (i) => `people/${String(i).padStart(6, '0')}.toml`;

// ── timing helpers ──────────────────────────────────────────────────────────

const ms = (t0, t1) => Number(t1 - t0) / 1e6;

function bench(name, iters, fn) {
  fn(-1); // warmup, not recorded
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    samples.push(ms(t0, process.hrtime.bigint()));
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { name, iters, min: samples[0], median, mean, max: samples[samples.length - 1] };
}

// ── 1. bulk load: N records → write → commit → ref advance ─────────────────

let rev = 0;
const t0 = process.hrtime.bigint();
{
  const tree = repo.createTree();
  for (let i = 0; i < N; i++) tree.writeChild(recordPath(i), record(i));
  const treeHash = tree.write();
  const commit = repo.commitTree(treeHash, [], `seed ${N} records`, SIG, SIG);
  repo.updateRef(REF, commit);
}
const bulkLoadMs = ms(t0, process.hrtime.bigint());

// ── 2–3. upsert→commit scenarios (each iteration advances the ref) ─────────

function upsert(count, iter) {
  const parent = repo.resolveRef(REF);
  const tree = repo.createTreeFromRef(REF);
  for (let k = 0; k < count; k++) {
    const i = ((iter + 1) * 7919 + k * 104729) % N; // deterministic spread
    tree.writeChild(recordPath(i), record(i, ++rev));
  }
  const treeHash = tree.write();
  const commit = repo.commitTree(treeHash, [parent], `upsert ${count} (iter ${iter})`, SIG, SIG);
  repo.updateRef(REF, commit, parent); // compare-and-swap
}

const results = [];
results.push(bench('single upsert→commit', ITERS, (i) => upsert(1, i)));
results.push(bench('500-record batch upsert→commit', Math.max(3, Math.floor(ITERS / 4)), (i) => upsert(500, i)));

// ── 4. read paths ───────────────────────────────────────────────────────────

results.push(
  bench('getBlobMap (full tree, fresh Tree)', ITERS, () => {
    const n = repo.createTreeFromRef(REF).getBlobMap().length;
    if (n !== N) throw new Error(`blob map size ${n} != ${N}`);
  }),
);

const READS = 200;
results.push(
  bench(`readBlob x${READS} (fresh Tree)`, ITERS, (i) => {
    const tree = repo.createTreeFromRef(REF);
    for (let k = 0; k < READS; k++) {
      const idx = (k * 92821 + (i + 1) * 31) % N;
      if (tree.readBlob(recordPath(idx)) === null) throw new Error(`missing record ${idx}`);
    }
  }),
);

const warmTree = repo.createTreeFromRef(REF);
results.push(
  bench(`readBlob x${READS} (warm Tree, repeated)`, ITERS, () => {
    for (let k = 0; k < READS; k++) {
      const idx = (k * 92821) % N;
      if (warmTree.readBlob(recordPath(idx)) === null) throw new Error(`missing record ${idx}`);
    }
  }),
);

// ── report ──────────────────────────────────────────────────────────────────

const meta = {
  profile,
  records: N,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};

if (opts.json) {
  console.log(JSON.stringify({ meta, bulkLoadMs, results }, null, 2));
} else {
  console.log(`holo-tree bench — ${meta.platform}, node ${meta.node}, build: ${profile}, records: ${N}`);
  if (profile !== 'release') console.log('!! NON-RELEASE BUILD — numbers below are not representative !!');
  console.log(`\nbulk load (${N} writeChild + write + commit + ref): ${bulkLoadMs.toFixed(1)}ms\n`);
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log(`${'scenario'.padEnd(pad)}  iters  median      min     mean      max`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(pad)}  ${String(r.iters).padStart(5)}  ` +
        `${r.median.toFixed(2).padStart(6)}ms ${r.min.toFixed(2).padStart(6)}ms ` +
        `${r.mean.toFixed(2).padStart(6)}ms ${r.max.toFixed(2).padStart(6)}ms`,
    );
  }
}
