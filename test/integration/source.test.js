/**
 * Source Integration Tests
 *
 * Tests the Source class functionality including HEAD resolution
 * and workspace source handling.
 */

const GitSandbox = require('../helpers/git-sandbox.js');
const Projection = require('../../lib/Projection.js');

describe('Source', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    describe('implicit workspace source', () => {
        test('source matching workspace name uses workspace tree', async () => {
            // When source name matches workspace name (e.g., _test-repo for workspace "test-repo"),
            // it automatically becomes a $workspace source
            await sandbox.addFile('app.js', 'content');
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.addBranch('main', {
                '_test-repo': { files: '**' }
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('main');
            const outputHash = await Projection.projectBranch(branch, { lens: false });

            // Should contain the file from workspace
            const files = await sandbox.listTree(outputHash);
            expect(files).toContain('app.js');
        });

        test('source resolves to valid commit hash', async () => {
            await sandbox.addFile('file.txt', 'content');
            await sandbox.initHolo({ name: 'my-project' });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            // Access source that matches workspace name (without underscore)
            const source = workspace.getSource('my-project');
            const head = await source.getHead();

            // Should be a valid commit hash
            expect(head).toMatch(/^[0-9a-f]{40}$/);
        });
    });

    describe('explicit source config', () => {
        test('reads source configuration from TOML', async () => {
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.addSource('example', {
                url: 'https://github.com/example/repo',
                ref: 'refs/heads/main'
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const source = workspace.getSource('example');
            const config = await source.getCachedConfig();

            expect(config.url).toBe('https://github.com/example/repo');
            expect(config.ref).toBe('refs/heads/main');
        });

        test('throws error when source has url but no ref', async () => {
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.addSource('bad-source', {
                url: 'https://github.com/example/repo'
                // Missing ref
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const source = workspace.getSource('bad-source');

            await expect(source.getCachedConfig()).rejects.toThrow('holosource has no ref defined');
        });
    });

    describe('getOutputTree', () => {
        test('returns tree hash for workspace source', async () => {
            await sandbox.addFile('src/app.js', 'app code');
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.addBranch('main', {
                '_test-repo': { files: 'src/**' }
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            // Access source without underscore prefix to match workspace name
            const source = workspace.getSource('test-repo');
            const treeHash = await source.getOutputTree();

            // Should return a valid tree hash (getOutputTree returns a hash string)
            expect(treeHash).toBeDefined();
            expect(treeHash).toMatch(/^[0-9a-f]{40}$/);
        });
    });
});
