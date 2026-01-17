/**
 * Projection Integration Tests
 *
 * Tests the core projection pipeline which is the primary functionality of hologit.
 * These tests verify that holobranches are correctly projected from configuration.
 */

const GitSandbox = require('../helpers/git-sandbox.js');
const Projection = require('../../lib/Projection.js');

describe('Projection.projectBranch', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    test('projects branch with self-source mapping', async () => {
        // Setup: Create a repo with files and holo config
        await sandbox.addFile('src/app.js', 'console.log("hello");');
        await sandbox.addFile('src/util.js', 'module.exports = {};');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('dist', {
            '_test-repo': {
                files: 'src/**'
            }
        });
        await sandbox.commit('initial setup');

        // Project the branch
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('dist');
        const outputHash = await Projection.projectBranch(branch, { lens: false });

        // Verify output contains the source files
        const files = await sandbox.listTree(outputHash);
        expect(files).toContain('src/app.js');
        expect(files).toContain('src/util.js');
    });

    test('projects branch with output path remapping', async () => {
        // Setup: Create files that will be remapped to different output path
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

        // Project the branch
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('dist');
        const outputHash = await Projection.projectBranch(branch, { lens: false });

        // Verify files are remapped
        const files = await sandbox.listTree(outputHash);
        expect(files).toContain('lib/app.js');
        expect(files).not.toContain('src/app.js');
    });

    test('merges multiple mappings in layer order', async () => {
        // Setup: Create files and multiple mappings
        await sandbox.addFile('base/config.json', '{"base": true}');
        await sandbox.addFile('override/config.json', '{"override": true}');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('combined', {
            // Use 'test-repo' (without underscore) to match workspace name
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

        // Project the branch
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('combined');
        const outputHash = await Projection.projectBranch(branch, { lens: false });

        // Verify override takes precedence
        const content = await sandbox.readFromTree(outputHash, 'config.json');
        expect(content).toBe('{"override": true}');
    });

    test('strips .holo/branches and .holo/sources from output', async () => {
        // Setup: Create minimal holo config
        await sandbox.addFile('app.js', 'console.log("app");');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('main', {
            '_test-repo': {
                files: '**'
            }
        });
        await sandbox.commit('initial setup');

        // Project the branch
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('main');
        const outputHash = await Projection.projectBranch(branch, { lens: false });

        // Verify .holo/branches and .holo/sources are stripped
        const files = await sandbox.listTree(outputHash);
        expect(files).toContain('app.js');
        expect(files.some(f => f.startsWith('.holo/branches/'))).toBe(false);
        expect(files.some(f => f.startsWith('.holo/sources/'))).toBe(false);
    });

    test('strips empty .holo directory when only config.toml remains', async () => {
        // Setup: Create repo with only app files (no lenses or other holo content)
        await sandbox.addFile('app.js', 'console.log("app");');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('main', {
            '_test-repo': {
                files: '**'
            }
        });
        await sandbox.commit('initial setup');

        // Project the branch
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('main');
        const outputHash = await Projection.projectBranch(branch, { lens: false });

        // Verify .holo is completely stripped (since only config.toml would remain)
        const files = await sandbox.listTree(outputHash);
        expect(files.some(f => f.startsWith('.holo/'))).toBe(false);
    });

    test('commitTo creates commit with proper ancestry', async () => {
        // Setup: Create repo with files
        await sandbox.addFile('app.js', 'v1');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('release', {
            '_test-repo': {
                files: '**'
            }
        });
        await sandbox.commit('initial setup');

        // Project and commit
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('release');
        const commitHash = await Projection.projectBranch(branch, {
            lens: false,
            commitTo: 'refs/heads/release-branch'
        });

        // Verify commit was created
        expect(commitHash).toMatch(/^[0-9a-f]{40}$/);

        // Verify ref was updated
        const refHash = await sandbox.git.revParse('refs/heads/release-branch');
        expect(refHash).toBe(commitHash);
    });

    test('respects before/after layer ordering', async () => {
        // Setup: Create multiple files that will be layered
        await sandbox.addFile('layers/first/file.txt', 'first');
        await sandbox.addFile('layers/second/file.txt', 'second');
        await sandbox.addFile('layers/third/file.txt', 'third');
        await sandbox.initHolo({ name: 'test-repo' });

        // Define mappings with explicit ordering: third after second after first
        // Use 'test-repo' (without underscore) to match workspace name
        await sandbox.addBranch('layered', {
            '_first-mapping': {
                holosource: 'test-repo',
                files: '**',
                root: 'layers/first',
                layer: 'first'
            },
            '_second-mapping': {
                holosource: 'test-repo',
                files: '**',
                root: 'layers/second',
                layer: 'second',
                after: ['first']
            },
            '_third-mapping': {
                holosource: 'test-repo',
                files: '**',
                root: 'layers/third',
                layer: 'third',
                after: ['second']
            }
        });
        await sandbox.commit('initial setup');

        // Project the branch
        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('layered');
        const outputHash = await Projection.projectBranch(branch, { lens: false });

        // Third layer should win since it comes after second which comes after first
        const content = await sandbox.readFromTree(outputHash, 'file.txt');
        expect(content).toBe('third');
    });
});
