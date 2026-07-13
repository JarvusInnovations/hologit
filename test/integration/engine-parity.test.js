/**
 * Engine Parity Integration Tests
 *
 * The determinism gate for the hybrid pipeline
 * (specs/behaviors/engine-selection.md): the Rust composition path and the
 * JS engine must produce hash-identical output for the same projection.
 *
 * These tests force each engine via HOLO_ENGINE and compare hashes. They
 * skip themselves when the holo-projector addon isn't built (the plain
 * `npm install` consumer state) — run `npm run build:projector-addon` first
 * to exercise them.
 */

const GitSandbox = require('../helpers/git-sandbox.js');
const Projection = require('../../lib/Projection.js');

let addon = null;
try {
    addon = require('../../holo-projector-napi');
} catch (err) {
    // not built — suite skips below
}

const describeWithAddon = addon ? describe : describe.skip;

describeWithAddon('engine parity (JS vs Rust composition)', () => {
    let sandbox;
    let originalEngine;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
        originalEngine = process.env.HOLO_ENGINE;
    });

    afterEach(async () => {
        if (originalEngine === undefined) {
            delete process.env.HOLO_ENGINE;
        } else {
            process.env.HOLO_ENGINE = originalEngine;
        }
        await sandbox.cleanup();
    });

    async function projectWithEngine (engine, branchName, options = { lens: false }) {
        process.env.HOLO_ENGINE = engine;
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch(branchName);
        return Projection.projectBranch(branch, options);
    }

    test('self-source projection with glob filters is hash-identical', async () => {
        await sandbox.addFile('src/app.js', 'console.log("hello");');
        await sandbox.addFile('src/util.js', 'module.exports = {};');
        await sandbox.addFile('docs/readme.md', '# readme');
        await sandbox.addFile('skip.log', 'noise');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('dist', {
            '_test-repo': {
                files: ['**', '!*.log']
            }
        });
        await sandbox.commit('initial setup');

        const jsHash = await projectWithEngine('js', 'dist');
        const rustHash = await projectWithEngine('rust', 'dist');

        expect(rustHash).toEqual(jsHash);
    });

    test('multi-mapping layered projection with remapping is hash-identical', async () => {
        await sandbox.addFile('base/config.json', '{"base": true}');
        await sandbox.addFile('base/only-base.txt', 'base');
        await sandbox.addFile('override/config.json', '{"override": true}');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('combined', {
            '_base-mapping': {
                holosource: 'test-repo',
                files: '**',
                root: 'base',
                layer: 'base'
            },
            '_override-mapping': {
                holosource: 'test-repo',
                files: '**',
                root: 'override',
                layer: 'override',
                after: ['base']
            }
        });
        await sandbox.commit('initial setup');

        const jsHash = await projectWithEngine('js', 'combined');
        const rustHash = await projectWithEngine('rust', 'combined');

        expect(rustHash).toEqual(jsHash);
    });

    test('projection with output remapping is hash-identical', async () => {
        await sandbox.addFile('src/app.js', 'console.log("hello");');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('dist', {
            '_test-repo': {
                files: '**',
                root: 'src',
                output: 'lib'
            }
        });
        await sandbox.commit('initial setup');

        const jsHash = await projectWithEngine('js', 'dist');
        const rustHash = await projectWithEngine('rust', 'dist');

        expect(rustHash).toEqual(jsHash);
    });
});
