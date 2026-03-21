#!/usr/bin/env node

/**
 * Projection Benchmark Runner
 *
 * Compares projection performance between:
 *   - `git holo` (installed release — baseline)
 *   - `node bin/cli.js` (local dev — optimized)
 *
 * Usage:
 *   BENCH_REPO=/path/to/repo BENCH_BRANCH=branch-name node test/benchmark/projection.bench.js
 */

const { execFile } = require('child_process');
const path = require('path');

const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS || '3', 10);

function runProjection(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        execFile(command, args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const elapsed = performance.now() - start;
            if (error) {
                reject(new Error(`${command} failed: ${error.message}\n${stderr}`));
                return;
            }
            resolve({
                hash: stdout.trim().split('\n').pop().trim(),
                elapsedMs: Math.round(elapsed)
            });
        });
    });
}

async function benchCommand(label, command, args, cwd) {
    const results = [];
    for (let i = 0; i < ITERATIONS; i++) {
        results.push(await runProjection(command, args, cwd));
    }

    const times = results.map(r => r.elapsedMs).sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length / 2)];
    const hash = results[results.length - 1].hash;

    console.log(`  ${label}:`);
    console.log(`    Hash:   ${hash}`);
    console.log(`    Median: ${medianMs}ms`);
    console.log(`    Runs:   ${times.join(', ')}ms`);

    return { label, hash, medianMs, times };
}

async function main() {
    const repoPath = process.env.BENCH_REPO;
    const branchName = process.env.BENCH_BRANCH;

    if (!repoPath || !branchName) {
        console.log('Usage: BENCH_REPO=/path/to/repo BENCH_BRANCH=branch-name node test/benchmark/projection.bench.js');
        console.log('\nExample: BENCH_REPO=~/codeforphilly.org BENCH_BRANCH=emergence-site npm run bench');
        process.exit(1);
    }

    const resolvedRepo = path.resolve(repoPath);
    const hologitBin = path.resolve(__dirname, '../../bin/cli.js');

    console.log('# Hologit Projection Benchmark');
    console.log(`Date:       ${new Date().toISOString()}`);
    console.log(`Node:       ${process.version}`);
    console.log(`Iterations: ${ITERATIONS}`);
    console.log(`Repo:       ${resolvedRepo}`);
    console.log(`Branch:     ${branchName}`);
    console.log();

    const baseline = await benchCommand(
        'Baseline (git holo)',
        'git', ['holo', 'project', branchName],
        resolvedRepo
    );

    const optimized = await benchCommand(
        'Optimized (local dev)',
        process.execPath, [hologitBin, 'project', branchName],
        resolvedRepo
    );

    console.log();
    if (baseline.hash === optimized.hash) {
        console.log(`  Hashes match: ${baseline.hash}`);
    } else {
        console.log(`  WARNING: Hash mismatch!`);
        console.log(`    Baseline:  ${baseline.hash}`);
        console.log(`    Optimized: ${optimized.hash}`);
    }

    const speedup = ((baseline.medianMs - optimized.medianMs) / baseline.medianMs * 100).toFixed(1);
    console.log(`  Speedup: ${speedup}% (${baseline.medianMs}ms -> ${optimized.medianMs}ms)`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
