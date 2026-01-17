/**
 * TreeObject.merge() Unit Tests
 *
 * Tests the core tree merging logic which is critical for holobranch projection.
 * The merge operation combines file trees with different modes:
 * - overlay: source files overwrite target files (default)
 * - replace: target tree is cleared, only source files remain
 * - underlay: source files only fill gaps, don't overwrite existing
 */

const GitSandbox = require('../helpers/git-sandbox.js');

describe('TreeObject.merge', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    describe('overlay mode (default)', () => {
        test('overwrites existing files with source files', async () => {
            // Setup target tree with a file
            await sandbox.addFile('file.txt', 'original content');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const targetTree = await repo.createTreeFromRef('HEAD');

            // Create source tree with same file, different content
            await sandbox.addFile('file.txt', 'new content');
            await sandbox.commit('update');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset target to original
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const originalTarget = await repo.createTreeFromRef('HEAD');

            // Merge source into target
            await originalTarget.merge(sourceTree, { mode: 'overlay' });

            // Write and verify
            const resultHash = await originalTarget.write();
            const content = await sandbox.readFromTree(resultHash, 'file.txt');

            expect(content).toBe('new content');
        });

        test('preserves existing files not in source', async () => {
            // Setup target with two files
            await sandbox.addFile('keep.txt', 'keep me');
            await sandbox.addFile('update.txt', 'original');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const targetTree = await repo.createTreeFromRef('HEAD');

            // Create source with only one file
            await sandbox.addFile('update.txt', 'updated');
            await sandbox.git.rm('keep.txt');
            await sandbox.commit('source');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset and merge
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const target = await repo.createTreeFromRef('HEAD');
            await target.merge(sourceTree, { mode: 'overlay' });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('keep.txt');
            expect(files).toContain('update.txt');
            expect(await sandbox.readFromTree(resultHash, 'keep.txt')).toBe('keep me');
            expect(await sandbox.readFromTree(resultHash, 'update.txt')).toBe('updated');
        });

        test('adds new files from source', async () => {
            // Setup target with one file
            await sandbox.addFile('existing.txt', 'existing');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();

            // Create source with additional file
            await sandbox.addFile('new.txt', 'new file');
            await sandbox.commit('add new');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset and merge
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const target = await repo.createTreeFromRef('HEAD');
            await target.merge(sourceTree, { mode: 'overlay' });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('existing.txt');
            expect(files).toContain('new.txt');
        });
    });

    describe('replace mode', () => {
        test('removes files not in source', async () => {
            // Setup target with files
            await sandbox.addFile('keep.txt', 'will be removed');
            await sandbox.addFile('shared.txt', 'shared');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();

            // Create source with only shared file
            await sandbox.git.rm('keep.txt');
            await sandbox.addFile('shared.txt', 'shared updated');
            await sandbox.commit('source');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset and merge with replace
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const target = await repo.createTreeFromRef('HEAD');
            await target.merge(sourceTree, { mode: 'replace' });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).not.toContain('keep.txt');
            expect(files).toContain('shared.txt');
        });
    });

    describe('underlay mode', () => {
        test('does not overwrite existing files', async () => {
            // Setup target with a file
            await sandbox.addFile('file.txt', 'original');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const target = await repo.createTreeFromRef('HEAD');

            // Create source with same file, different content
            await sandbox.addFile('file.txt', 'should not appear');
            await sandbox.commit('source');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset and merge with underlay
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const freshTarget = await repo.createTreeFromRef('HEAD');
            await freshTarget.merge(sourceTree, { mode: 'underlay' });

            const resultHash = await freshTarget.write();
            const content = await sandbox.readFromTree(resultHash, 'file.txt');

            expect(content).toBe('original');
        });

        test('fills gaps with source files', async () => {
            // Setup target with one file
            await sandbox.addFile('existing.txt', 'existing');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();

            // Create source with additional file
            await sandbox.addFile('new.txt', 'new from source');
            await sandbox.commit('add new');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset and merge with underlay
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const target = await repo.createTreeFromRef('HEAD');
            await target.merge(sourceTree, { mode: 'underlay' });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('existing.txt');
            expect(files).toContain('new.txt');
            expect(await sandbox.readFromTree(resultHash, 'existing.txt')).toBe('existing');
        });
    });

    describe('file pattern matching', () => {
        test('includes only files matching glob pattern', async () => {
            // Setup source with multiple file types
            await sandbox.addFile('src/app.js', 'js content');
            await sandbox.addFile('src/style.css', 'css content');
            await sandbox.addFile('src/index.html', 'html content');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Create empty target and merge with pattern
            const target = repo.createTree();
            await target.merge(sourceTree, { files: ['**/*.js'] });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('src/app.js');
            expect(files).not.toContain('src/style.css');
            expect(files).not.toContain('src/index.html');
        });

        test('supports multiple glob patterns', async () => {
            // Setup source with multiple file types
            await sandbox.addFile('src/app.js', 'js');
            await sandbox.addFile('src/app.ts', 'ts');
            await sandbox.addFile('src/style.css', 'css');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Merge with multiple patterns
            const target = repo.createTree();
            await target.merge(sourceTree, { files: ['**/*.js', '**/*.ts'] });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('src/app.js');
            expect(files).toContain('src/app.ts');
            expect(files).not.toContain('src/style.css');
        });

        test('supports negation patterns', async () => {
            // Setup source with files including node_modules
            await sandbox.addFile('src/app.js', 'app');
            await sandbox.addFile('node_modules/lib/index.js', 'lib');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Merge excluding node_modules
            const target = repo.createTree();
            await target.merge(sourceTree, { files: ['**', '!node_modules/**'] });

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('src/app.js');
            expect(files).not.toContain('node_modules/lib/index.js');
        });
    });

    describe('dirty tracking', () => {
        test('marks tree as dirty after merge', async () => {
            await sandbox.addFile('file.txt', 'content');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const source = await repo.createTreeFromRef('HEAD');
            const target = repo.createTree();

            expect(target.dirty).toBe(false);

            await target.merge(source);

            expect(target.dirty).toBe(true);
        });

        test('propagates dirty state to parent trees', async () => {
            await sandbox.addFile('deep/nested/file.txt', 'content');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const source = await repo.createTreeFromRef('HEAD');
            const target = repo.createTree();

            await target.merge(source);

            // After write, check parent chain was properly handled
            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('deep/nested/file.txt');
            expect(target.dirty).toBe(false);
        });

        test('write resets dirty state', async () => {
            await sandbox.addFile('file.txt', 'content');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();
            const source = await repo.createTreeFromRef('HEAD');
            const target = repo.createTree();

            await target.merge(source);
            expect(target.dirty).toBe(true);

            await target.write();
            expect(target.dirty).toBe(false);
        });
    });

    describe('nested directory merging', () => {
        test('merges nested directories correctly', async () => {
            // Setup target with nested structure
            await sandbox.addFile('a/b/c/file1.txt', 'file1');
            await sandbox.commit('initial');

            const repo = await sandbox.getRepo();

            // Add more nested files
            await sandbox.addFile('a/b/c/file2.txt', 'file2');
            await sandbox.addFile('a/b/d/file3.txt', 'file3');
            await sandbox.commit('add more');

            const sourceTree = await repo.createTreeFromRef('HEAD');

            // Reset and merge
            await sandbox.git.reset({ hard: true }, 'HEAD~1');
            const target = await repo.createTreeFromRef('HEAD');
            await target.merge(sourceTree);

            const resultHash = await target.write();
            const files = await sandbox.listTree(resultHash);

            expect(files).toContain('a/b/c/file1.txt');
            expect(files).toContain('a/b/c/file2.txt');
            expect(files).toContain('a/b/d/file3.txt');
        });
    });
});
