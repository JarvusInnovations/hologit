/**
 * Branch Integration Tests
 *
 * Tests the Branch class functionality including mapping resolution,
 * topological sorting, and branch extension.
 */

const GitSandbox = require('../helpers/git-sandbox.js');
// Import Projection at module level to resolve circular dependency before tests run
const Projection = require('../../lib/Projection.js');

describe('Branch', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    describe('getMappings', () => {
        test('returns mappings defined in branch directory', async () => {
            await sandbox.addFile('src/app.js', 'app');
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.addBranch('main', {
                '_test-repo': {
                    files: 'src/**'
                }
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('main');
            const mappings = await branch.getMappings();

            expect(mappings.size).toBe(1);
            expect(mappings.has('_test-repo')).toBe(true);
        });

        test('topologically sorts mappings by before/after', async () => {
            await sandbox.addFile('a/file.txt', 'a');
            await sandbox.addFile('b/file.txt', 'b');
            await sandbox.addFile('c/file.txt', 'c');
            await sandbox.initHolo({ name: 'test-repo' });

            // Define mappings with ordering: a before b before c
            // Use 'test-repo' (without underscore) to match workspace name
            await sandbox.addBranch('ordered', {
                '_c': {
                    holosource: 'test-repo',
                    files: '**',
                    root: 'c',
                    layer: 'c',
                    after: ['b']
                },
                '_a': {
                    holosource: 'test-repo',
                    files: '**',
                    root: 'a',
                    layer: 'a'
                },
                '_b': {
                    holosource: 'test-repo',
                    files: '**',
                    root: 'b',
                    layer: 'b',
                    after: ['a']
                }
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('ordered');
            const mappings = await branch.getMappings();

            // Convert to array to check order
            const mappingNames = [...mappings.keys()];

            // a should come before b, b should come before c
            expect(mappingNames.indexOf('_a')).toBeLessThan(mappingNames.indexOf('_b'));
            expect(mappingNames.indexOf('_b')).toBeLessThan(mappingNames.indexOf('_c'));
        });
    });

    describe('extend', () => {
        test('inherits mappings from extended branch', async () => {
            await sandbox.addFile('base/file.txt', 'base content');
            await sandbox.addFile('child/file.txt', 'child content');
            await sandbox.initHolo({ name: 'test-repo' });

            // Create base branch using workspace source (test-repo without underscore)
            await sandbox.addBranch('base', {
                '_base-mapping': {
                    holosource: 'test-repo',
                    files: '**',
                    root: 'base'
                }
            });

            // Create child branch that extends base
            await sandbox.addBranch('child', {
                '_child-mapping': {
                    holosource: 'test-repo',
                    files: '**',
                    root: 'child'
                }
            }, { extend: 'base' });

            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('child');
            const outputHash = await Projection.projectBranch(branch, { lens: false });

            // Should contain file from child (overwrites base)
            const content = await sandbox.readFromTree(outputHash, 'file.txt');
            expect(content).toBe('child content');
        });

        test('chains multiple extend levels', async () => {
            await sandbox.addFile('l1/a.txt', 'level 1');
            await sandbox.addFile('l2/b.txt', 'level 2');
            await sandbox.addFile('l3/c.txt', 'level 3');
            await sandbox.initHolo({ name: 'test-repo' });

            // Create chain: l3 extends l2 extends l1
            // Use 'test-repo' (without underscore) to match workspace name
            await sandbox.addBranch('l1', {
                '_l1-mapping': { holosource: 'test-repo', files: '**', root: 'l1' }
            });
            await sandbox.addBranch('l2', {
                '_l2-mapping': { holosource: 'test-repo', files: '**', root: 'l2' }
            }, { extend: 'l1' });
            await sandbox.addBranch('l3', {
                '_l3-mapping': { holosource: 'test-repo', files: '**', root: 'l3' }
            }, { extend: 'l2' });

            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('l3');
            const outputHash = await Projection.projectBranch(branch, { lens: false });

            // Should contain files from all levels
            const files = await sandbox.listTree(outputHash);
            expect(files).toContain('a.txt');
            expect(files).toContain('b.txt');
            expect(files).toContain('c.txt');
        });
    });

    describe('isDefined', () => {
        test('returns truthy for defined branch', async () => {
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.addBranch('exists', {
                '_test-repo': { files: '**' }
            });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('exists');

            expect(await branch.isDefined()).toBeTruthy();
        });

        test('returns falsy for undefined branch', async () => {
            await sandbox.initHolo({ name: 'test-repo' });
            await sandbox.commit('initial');

            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('nonexistent');

            expect(await branch.isDefined()).toBeFalsy();
        });
    });
});
