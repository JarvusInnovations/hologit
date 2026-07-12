/**
 * Watch Mode Integration Tests (specs/behaviors/watch.md)
 *
 * Drives `project --watch` as a real child process against a sandbox repo in
 * ref mode: the initial publication, re-projection on ref advance, duplicate
 * suppression, and per-cycle commits. Engine-agnostic — runs identically
 * under the hybrid dispatcher with or without the Rust addon built.
 */

const path = require('path');
const { spawn } = require('child_process');

const GitSandbox = require('../helpers/git-sandbox.js');

const CLI = path.join(__dirname, '../../bin/cli.js');

/** Spawn `project <holobranch> --watch` and collect stdout lines. */
function spawnWatch (sandbox, args) {
    const child = spawn('node', [CLI, 'project', ...args], {
        cwd: sandbox.dir,
        env: { ...process.env, GIT_DIR: sandbox.gitDir, GIT_WORK_TREE: sandbox.dir },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const lines = [];
    const waiters = [];
    let stderr = '';
    let buffered = '';

    child.stdout.on('data', (chunk) => {
        buffered += chunk;
        let newlineIndex;
        while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
            lines.push(buffered.slice(0, newlineIndex));
            buffered = buffered.slice(newlineIndex + 1);
            waiters.splice(0).forEach((check) => check());
        }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const waitForLines = (count, timeoutMs = 20000) => new Promise((resolve, reject) => {
        const deadline = setTimeout(
            () => reject(new Error(`timed out waiting for ${count} output lines, have ${lines.length}; stderr:\n${stderr}`)),
            timeoutMs
        );
        const check = () => {
            if (lines.length >= count) {
                clearTimeout(deadline);
                resolve();
            } else {
                waiters.push(check);
            }
        };
        check();
    });

    return { child, lines, waitForLines };
}

describe('project --watch (ref mode)', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();

        await sandbox.addFile('src/app.js', 'console.log("v1");\n');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('dist', {
            '_test-repo': {
                files: 'src/**'
            }
        });
        await sandbox.commit('initial setup');
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    test('publishes the initial projection, re-projects on ref advance, and commits per cycle', async () => {
        const { child, lines, waitForLines } = spawnWatch(sandbox, [
            'dist', '--watch', '--no-lens', '--no-cache-from', '--commit-to=refs/heads/projected'
        ]);

        try {
            // initial publication: a watch session's first output is the
            // current state, and with --commit-to it is a commit hash
            await waitForLines(1);
            const initialTree = await sandbox.git.revParse(`${lines[0]}^{tree}`);
            expect(await sandbox.listTree(initialTree)).toEqual(['src/app.js']);
            expect(await sandbox.git.revParse('refs/heads/projected')).toEqual(lines[0]);

            // ref advance triggers a re-projection cycle
            await sandbox.addFile('src/app.js', 'console.log("v2");\n');
            await sandbox.addFile('src/extra.js', 'module.exports = 2;\n');
            await sandbox.commit('v2');
            await waitForLines(2);

            const cycleTree = await sandbox.git.revParse(`${lines[1]}^{tree}`);
            expect(await sandbox.listTree(cycleTree)).toEqual(['src/app.js', 'src/extra.js']);

            // per-cycle commit: the target ref advanced to the published
            // commit, whose first parent is the previous projection commit
            // (specs/behaviors/projection-commits.md)
            expect(await sandbox.git.revParse('refs/heads/projected')).toEqual(lines[1]);
            expect(await sandbox.git.revParse(`${lines[1]}^1`)).toEqual(lines[0]);

            // the cycle's source commit rides along as second parent
            expect(await sandbox.git.revParse(`${lines[1]}^2`)).toEqual(await sandbox.git.revParse('HEAD'));
        } finally {
            child.kill('SIGTERM');
        }
    });

    test('suppresses cycles whose input tree is unchanged', async () => {
        const { child, lines, waitForLines } = spawnWatch(sandbox, [
            'dist', '--watch', '--no-lens', '--no-cache-from'
        ]);

        try {
            await waitForLines(1);

            // an empty commit changes the ref but not the input tree —
            // duplicate suppression is by hash, not by event
            await sandbox.git.commit({ 'allow-empty': true, m: 'no tree change' });

            // a real change afterward must still publish exactly one line
            await sandbox.addFile('src/app.js', 'console.log("v3");\n');
            await sandbox.commit('v3');
            await waitForLines(2);

            // allow any (wrongly) queued duplicate cycle to flush
            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(lines).toHaveLength(2);
        } finally {
            child.kill('SIGTERM');
        }
    });
});
