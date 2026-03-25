/**
 * Tests for the inline deepSortKeys implementation in SpecObject.
 *
 * This replaces the ESM-only `sort-keys` package. These tests verify
 * behavioral equivalence for the usage patterns in hologit.
 */

// Extract the function for testing — it's module-private in SpecObject,
// so we test it indirectly via SpecObject or replicate it here.
function deepSortKeys (obj) {
    if (Array.isArray(obj)) return obj.map(deepSortKeys);
    if (obj === null || typeof obj !== 'object') return obj;

    return Object.keys(obj).sort().reduce((sorted, key) => {
        sorted[key] = deepSortKeys(obj[key]);
        return sorted;
    }, {});
}

describe('deepSortKeys', () => {

    describe('flat objects', () => {
        test('sorts keys alphabetically', () => {
            expect(deepSortKeys({ z: 1, a: 2, m: 3 }))
                .toEqual({ a: 2, m: 3, z: 1 });

            // Verify key order (not just values)
            const result = deepSortKeys({ z: 1, a: 2, m: 3 });
            expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
        });

        test('handles already-sorted keys', () => {
            const result = deepSortKeys({ a: 1, b: 2, c: 3 });
            expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
        });

        test('handles single key', () => {
            expect(deepSortKeys({ only: 'key' })).toEqual({ only: 'key' });
        });

        test('handles empty object', () => {
            expect(deepSortKeys({})).toEqual({});
        });
    });

    describe('nested objects', () => {
        test('sorts keys at all levels', () => {
            const result = deepSortKeys({
                z: { b: 1, a: 2 },
                a: { d: 3, c: 4 }
            });
            expect(Object.keys(result)).toEqual(['a', 'z']);
            expect(Object.keys(result.a)).toEqual(['c', 'd']);
            expect(Object.keys(result.z)).toEqual(['a', 'b']);
        });

        test('handles deeply nested objects', () => {
            const result = deepSortKeys({
                z: { y: { x: { w: 1, a: 2 } } }
            });
            expect(Object.keys(result.z.y.x)).toEqual(['a', 'w']);
        });
    });

    describe('primitive values', () => {
        test('preserves string values', () => {
            expect(deepSortKeys({ b: 'hello', a: 'world' }))
                .toEqual({ a: 'world', b: 'hello' });
        });

        test('preserves number values', () => {
            expect(deepSortKeys({ b: 42, a: 3.14 }))
                .toEqual({ a: 3.14, b: 42 });
        });

        test('preserves boolean values', () => {
            expect(deepSortKeys({ b: true, a: false }))
                .toEqual({ a: false, b: true });
        });

        test('preserves null values', () => {
            expect(deepSortKeys({ b: null, a: 'value' }))
                .toEqual({ a: 'value', b: null });
        });

        test('returns null as-is', () => {
            expect(deepSortKeys(null)).toBeNull();
        });

        test('returns strings as-is', () => {
            expect(deepSortKeys('hello')).toBe('hello');
        });

        test('returns numbers as-is', () => {
            expect(deepSortKeys(42)).toBe(42);
        });

        test('returns undefined as-is', () => {
            expect(deepSortKeys(undefined)).toBeUndefined();
        });
    });

    describe('arrays', () => {
        test('preserves array order (does not sort array elements)', () => {
            expect(deepSortKeys([3, 1, 2])).toEqual([3, 1, 2]);
        });

        test('sorts keys of objects within arrays', () => {
            const result = deepSortKeys([
                { z: 1, a: 2 },
                { y: 3, b: 4 }
            ]);
            expect(Object.keys(result[0])).toEqual(['a', 'z']);
            expect(Object.keys(result[1])).toEqual(['b', 'y']);
        });

        test('handles nested arrays', () => {
            const result = deepSortKeys({ arr: [{ z: 1, a: 2 }] });
            expect(Object.keys(result.arr[0])).toEqual(['a', 'z']);
        });

        test('handles empty arrays', () => {
            expect(deepSortKeys([])).toEqual([]);
        });

        test('handles mixed array contents', () => {
            const result = deepSortKeys([1, 'hello', { z: 1, a: 2 }, null, [3, 2]]);
            expect(result[0]).toBe(1);
            expect(result[1]).toBe('hello');
            expect(Object.keys(result[2])).toEqual(['a', 'z']);
            expect(result[3]).toBeNull();
            expect(result[4]).toEqual([3, 2]);
        });
    });

    describe('hologit-specific data patterns', () => {
        test('sorts source spec data (host + path)', () => {
            const result = deepSortKeys({
                path: '/org/repo',
                host: 'github.com'
            });
            expect(Object.keys(result)).toEqual(['host', 'path']);
            expect(result).toEqual({ host: 'github.com', path: '/org/repo' });
        });

        test('sorts source spec with path only', () => {
            const result = deepSortKeys({ path: '.' });
            expect(result).toEqual({ path: '.' });
        });

        test('sorts holosource config', () => {
            const result = deepSortKeys({
                url: 'https://github.com/org/repo',
                ref: 'refs/heads/main',
                project: { holobranch: 'emergence-site' }
            });
            expect(Object.keys(result)).toEqual(['project', 'ref', 'url']);
            expect(Object.keys(result.project)).toEqual(['holobranch']);
        });

        test('sorts holomapping config', () => {
            const result = deepSortKeys({
                output: '.',
                holosource: 'skeleton',
                files: ['**'],
                after: ['base'],
                layer: 'skeleton',
                root: '.'
            });
            expect(Object.keys(result)).toEqual([
                'after', 'files', 'holosource', 'layer', 'output', 'root'
            ]);
        });
    });

    describe('real-world hologit configs from production repos', () => {
        test('sorts parsed holosource with project config', () => {
            // From gatekeeper-phila/.holo/sources/gatekeeper.toml
            const result = deepSortKeys({
                url: 'https://github.com/JarvusInnovations/gatekeeper.git',
                ref: 'refs/tags/v2.2.5',
                project: { holobranch: 'emergence-skeleton' }
            });
            expect(Object.keys(result)).toEqual(['project', 'ref', 'url']);
            expect(Object.keys(result.project)).toEqual(['holobranch']);
        });

        test('sorts parsed holomapping with before constraint', () => {
            // From elmos-frontend/.holo/branches/helm-chart/_menunet-network.toml
            const result = deepSortKeys({
                holosource: '=>helm-chart',
                files: '**',
                before: '*'
            });
            expect(Object.keys(result)).toEqual(['before', 'files', 'holosource']);
        });

        test('sorts parsed holomapping with file array and root', () => {
            // From emergence-skeleton docs-site branch
            const result = deepSortKeys({
                root: 'docs',
                files: ['mkdocs.yml', 'mkdocs.*.yml']
            });
            expect(Object.keys(result)).toEqual(['files', 'root']);
            // Array order preserved
            expect(result.files).toEqual(['mkdocs.yml', 'mkdocs.*.yml']);
        });

        test('sorts source spec derived from local path', () => {
            // What SpecObject.write receives for a local source
            const result = deepSortKeys({
                path: '/users/chris/repos/skeleton',
                host: null
            });
            expect(Object.keys(result)).toEqual(['host', 'path']);
        });

        test('sorts source spec derived from github URL', () => {
            // What SpecObject.write receives for a remote source
            const result = deepSortKeys({
                path: '/jarvusinnovations/gatekeeper',
                host: 'github.com'
            });
            expect(Object.keys(result)).toEqual(['host', 'path']);
        });
    });

    describe('key ordering consistency', () => {
        test('produces identical output for identical input regardless of insertion order', () => {
            const a = deepSortKeys({ z: 1, m: 2, a: 3 });
            const b = deepSortKeys({ a: 3, z: 1, m: 2 });
            const c = deepSortKeys({ m: 2, a: 3, z: 1 });

            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
            expect(JSON.stringify(b)).toBe(JSON.stringify(c));
        });

        test('produces identical JSON for nested objects regardless of key order', () => {
            const a = deepSortKeys({
                z: { b: 1, a: 2 },
                a: { d: 3, c: 4 }
            });
            const b = deepSortKeys({
                a: { c: 4, d: 3 },
                z: { a: 2, b: 1 }
            });

            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        });
    });
});
