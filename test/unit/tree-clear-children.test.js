/**
 * TreeObject.clearChildren() Unit Tests
 *
 * Covers the O(1) "drop everything under this subtree" operation —
 * semantically equivalent to deleteChild per-entry but constant-time
 * regardless of subtree size.
 */

const GitSandbox = require('../helpers/git-sandbox.js');

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// TreeObject._children stores pending edits as own properties and lazy-
// loaded base children on the prototype chain. `Object.keys` only sees
// own properties; this helper walks the chain via `for...in` to surface
// every name an entry has, then filters out names with falsy (null /
// deleted) values — matching what `write()` does internally.
function visibleNames(children) {
    const names = [];
    for (const name in children) {
        if (children[name]) names.push(name);
    }
    return names.sort();
}

describe('TreeObject.clearChildren', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        await sandbox.cleanup();
    });

    test('serialized hash of a cleared tree is EMPTY_TREE_HASH', async () => {
        await sandbox.addFile('a.txt', 'a');
        await sandbox.addFile('b.txt', 'b');
        await sandbox.addFile('c.txt', 'c');
        await sandbox.commit('three files');

        const repo = await sandbox.getRepo();
        const tree = await repo.createTreeFromRef('HEAD');

        // Sanity: tree is non-empty before clearing.
        const before = await tree.getChildren();
        expect(visibleNames(before).length).toBeGreaterThanOrEqual(3);

        tree.clearChildren();
        const hash = await tree.getHash();

        expect(hash).toBe(EMPTY_TREE_HASH);
    });

    test('getChildren returns no entries after clearChildren', async () => {
        await sandbox.addFile('a.txt', 'a');
        await sandbox.addFile('b.txt', 'b');
        await sandbox.commit('two files');

        const repo = await sandbox.getRepo();
        const tree = await repo.createTreeFromRef('HEAD');

        tree.clearChildren();
        const children = await tree.getChildren();

        expect(visibleNames(children)).toEqual([]);
    });

    test('does not depend on _baseChildren having been loaded first', async () => {
        // Important: this test calls clearChildren BEFORE any operation
        // that would have loaded the base children from the git tree.
        // The clear should still produce an empty result.
        await sandbox.addFile('a.txt', 'a');
        await sandbox.addFile('b.txt', 'b');
        await sandbox.commit('two files');

        const repo = await sandbox.getRepo();
        const tree = await repo.createTreeFromRef('HEAD');

        // No prior getChildren / getBlobMap / getChild — base children
        // were never lazy-loaded.
        tree.clearChildren();
        expect(await tree.getHash()).toBe(EMPTY_TREE_HASH);
    });

    test('writeChild after clearChildren leaves only the new content', async () => {
        await sandbox.addFile('old-a.txt', 'a');
        await sandbox.addFile('old-b.txt', 'b');
        await sandbox.commit('old');

        const repo = await sandbox.getRepo();
        const tree = await repo.createTreeFromRef('HEAD');

        tree.clearChildren();
        await tree.writeChild('new.txt', 'new content');

        const children = await tree.getChildren();
        expect(visibleNames(children)).toEqual(['new.txt']);
    });

    test('subtree clear propagates dirty to parent', async () => {
        await sandbox.addFile('keep/keep.txt', 'k');
        await sandbox.addFile('drop/a.txt', 'a');
        await sandbox.addFile('drop/b.txt', 'b');
        await sandbox.commit('seed');

        const repo = await sandbox.getRepo();
        const root = await repo.createTreeFromRef('HEAD');
        const drop = await root.getSubtree('drop', false);
        expect(drop).not.toBeNull();

        drop.clearChildren();
        expect(drop.dirty).toBe(true);
        expect(root.dirty).toBe(true);

        // Writing the parent produces a tree containing only 'keep/'.
        const rootHash = await root.getHash();
        const rebuilt = await repo.createTreeFromRef(rootHash);
        const rebuiltChildren = await rebuilt.getChildren();
        expect(visibleNames(rebuiltChildren)).toEqual(['keep']);
    });

    test('clearing an already-empty tree is a safe no-op', async () => {
        await sandbox.commit('empty');

        const repo = await sandbox.getRepo();
        const tree = await repo.createTreeFromRef('HEAD');

        // Should not throw, and the hash stays at the empty-tree value.
        tree.clearChildren();
        expect(await tree.getHash()).toBe(EMPTY_TREE_HASH);
    });
});
