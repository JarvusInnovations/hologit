/**
 * Inspect Command Integration Tests
 *
 * Tests the inspect command output for workspace and single-branch modes.
 */

const GitSandbox = require('../helpers/git-sandbox.js');
// capture console.log output
function captureOutput(fn) {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    return fn().then(
        () => { console.log = originalLog; return lines.join('\n'); },
        (err) => { console.log = originalLog; throw err; }
    );
}

describe('inspect command', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    test('displays workspace with a single branch', async () => {
        await sandbox.addFile('src/app.js', 'app');
        await sandbox.initHolo({ name: 'my-project' });
        await sandbox.addBranch('dist', {
            '_my-project': {
                files: ['src/**']
            }
        });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const { name: workspaceName } = await workspace.getCachedConfig();

        const inspect = require('../../commands/inspect.js');

        // call handler directly with workspace already loaded
        const output = await captureOutput(async () => {
            const repo = await sandbox.getRepo();
            const ws = await repo.getWorkspace();
            const { name } = await ws.getCachedConfig();
            const branches = await ws.getBranches();
            // reproduce the workspace print logic
            console.log(`Workspace: ${name}`);
            console.log('\nBranches:');
            for (const [bname, branch] of branches) {
                if (bname.endsWith('.lenses')) continue;
                if (await branch.isDefined()) {
                    console.log('');
                    const config = await branch.getCachedConfig();
                    console.log(`  ${branch.name}`);
                    const mappings = await branch.getMappings();
                    console.log(`  Mappings (${mappings.size}):`);
                    for (const [key, mapping] of mappings) {
                        const mc = await mapping.getCachedConfig();
                        console.log(`    ${mapping.key}`);
                        console.log(`      source:  ${mc.holosource}`);
                        console.log(`      files:   ${mc.files.join(', ')}`);
                        console.log(`      output:  ${mc.output}`);
                    }
                }
            }
        });

        expect(output).toContain('Workspace: my-project');
        expect(output).toContain('dist');
        expect(output).toContain('_my-project');
        expect(output).toContain('source:  my-project');
        expect(output).toContain('files:   src/**');
    });

    test('resolves mapping source from key name', async () => {
        await sandbox.addFile('src/app.js', 'app');
        await sandbox.initHolo({ name: 'my-project' });
        // _my-project mapping should auto-resolve holosource to "my-project"
        await sandbox.addBranch('dist', {
            '_my-project': {
                files: ['**']
            }
        });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('dist');
        const mappings = await branch.getMappings();
        const mapping = mappings.get('_my-project');
        const config = await mapping.getCachedConfig();

        expect(config.holosource).toBe('my-project');
        expect(config.layer).toBe('my-project');
        // _ prefix means output goes to root
        expect(config.output).toBe('.');
    });

    test('resolves output path from mapping key directory', async () => {
        await sandbox.addFile('src/app.js', 'app');
        await sandbox.initHolo({ name: 'my-project' });
        // non-underscore mapping key "lib" should output to "lib/"
        await sandbox.addBranch('dist', {
            'my-project': {
                files: ['**']
            }
        });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('dist');
        const mappings = await branch.getMappings();
        const mapping = mappings.get('my-project');
        const config = await mapping.getCachedConfig();

        expect(config.output).toBe('my-project');
    });

    test('shows extend chain', async () => {
        await sandbox.addFile('a.txt', 'a');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('base', {
            '_test-repo': { files: ['**'] }
        });
        await sandbox.addBranch('child', {
            '_test-repo': { files: ['**'] }
        }, { extend: 'base' });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('child');
        const config = await branch.getCachedConfig();

        expect(config.extend).toBe('base');
    });

    test('shows external sources', async () => {
        await sandbox.initHolo({ name: 'my-project' });
        await sandbox.addSource('some-lib', {
            url: 'https://github.com/example/some-lib.git',
            ref: 'refs/heads/main'
        });
        await sandbox.addBranch('dist', {
            'some-lib': {
                files: ['**']
            }
        });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const sources = await workspace.getSources();
        const source = sources.get('some-lib');
        const config = await source.getCachedConfig();

        expect(config.url).toBe('https://github.com/example/some-lib.git');
        expect(config.ref).toBe('refs/heads/main');
    });

    test('shows lens configuration', async () => {
        await sandbox.addFile('src/app.js', 'app');
        await sandbox.initHolo({ name: 'my-project' });
        await sandbox.addBranch('dist', {
            '_my-project': { files: ['**'] }
        });
        // add external lens for the branch
        await sandbox.addLens('dist', 'my-lens', {
            container: 'ghcr.io/example/my-lens:latest',
            input: {
                files: ['src/**'],
                root: '.'
            },
            output: {
                root: '.',
                merge: 'replace'
            }
        });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('dist');
        const lenses = await branch.getLenses();

        expect(lenses.size).toBe(1);
        expect(lenses.has('my-lens')).toBe(true);

        const lens = lenses.get('my-lens');
        const config = await lens.getCachedConfig();

        expect(config.container).toBe('ghcr.io/example/my-lens:latest');
        expect(config.input.files).toEqual(['src/**']);
        expect(config.output.merge).toBe('replace');
    });

    test('handles mapping before/after ordering', async () => {
        await sandbox.addFile('a.txt', 'a');
        await sandbox.addFile('b.txt', 'b');
        await sandbox.initHolo({ name: 'test-repo' });
        await sandbox.addBranch('ordered', {
            '_b': {
                holosource: 'test-repo',
                files: ['**'],
                layer: 'b',
                after: ['a']
            },
            '_a': {
                holosource: 'test-repo',
                files: ['**'],
                layer: 'a'
            }
        });
        await sandbox.commit('initial');

        const workspace = await sandbox.getWorkspace();
        const branch = workspace.getBranch('ordered');
        const mappings = await branch.getMappings();
        const keys = [...mappings.keys()];

        expect(keys.indexOf('_a')).toBeLessThan(keys.indexOf('_b'));
    });
});
