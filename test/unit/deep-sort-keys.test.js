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

    describe('real-world hologit config patterns', () => {
        test('sorts parsed holosource with project config', () => {
            const result = deepSortKeys({
                url: 'https://github.com/example-org/my-app.git',
                ref: 'refs/tags/v2.2.5',
                project: { holobranch: 'emergence-skeleton' }
            });
            expect(Object.keys(result)).toEqual(['project', 'ref', 'url']);
            expect(Object.keys(result.project)).toEqual(['holobranch']);
        });

        test('sorts parsed holomapping with before constraint', () => {
            const result = deepSortKeys({
                holosource: '=>helm-chart',
                files: '**',
                before: '*'
            });
            expect(Object.keys(result)).toEqual(['before', 'files', 'holosource']);
        });

        test('sorts parsed holomapping with file array and root', () => {
            const result = deepSortKeys({
                root: 'docs',
                files: ['mkdocs.yml', 'mkdocs.*.yml']
            });
            expect(Object.keys(result)).toEqual(['files', 'root']);
            expect(result.files).toEqual(['mkdocs.yml', 'mkdocs.*.yml']);
        });

        test('sorts source spec derived from local path', () => {
            const result = deepSortKeys({
                path: '/users/dev/repos/skeleton',
                host: null
            });
            expect(Object.keys(result)).toEqual(['host', 'path']);
        });

        test('sorts source spec derived from github URL', () => {
            const result = deepSortKeys({
                path: '/example-org/my-app',
                host: 'github.com'
            });
            expect(Object.keys(result)).toEqual(['host', 'path']);
        });
    });

    describe('lens spec data patterns', () => {
        test('sorts container lens spec with nested input/output', () => {
            const result = deepSortKeys({
                container: 'ghcr.io/hologit/lenses/sencha-pages@sha256:abc123',
                input: 'aabbccdd',
                output: null,
                before: null,
                after: null,
                root: 'sencha-workspace',
                files: ['ext/**', 'pages/**'],
                merge: 'overlay'
            });
            expect(Object.keys(result)).toEqual([
                'after', 'before', 'container', 'files', 'input', 'merge', 'output', 'root'
            ]);
            expect(result.files).toEqual(['ext/**', 'pages/**']);
        });

        test('sorts habitat lens spec with nested helm config', () => {
            const result = deepSortKeys({
                package: 'holo/lens-helm3/1.22',
                before: 'k8s-normalize',
                input: 'aabbccdd',
                output: null,
                after: null,
                root: 'my-api-staging',
                files: '**',
                merge: 'replace',
                helm: {
                    namespace: 'app-staging',
                    release_name: 'my-api-staging',
                    chart_path: 'helm-chart',
                    value_files: ['release-values.yaml']
                }
            });
            expect(Object.keys(result)).toEqual([
                'after', 'before', 'files', 'helm', 'input', 'merge', 'output', 'package', 'root'
            ]);
            expect(Object.keys(result.helm)).toEqual([
                'chart_path', 'namespace', 'release_name', 'value_files'
            ]);
            expect(result.helm.value_files).toEqual(['release-values.yaml']);
        });

        test('sorts yarn-run lens spec with nested config', () => {
            const result = deepSortKeys({
                package: 'holo/lens-yarn-run',
                input: 'aabbccdd',
                output: null,
                before: null,
                after: null,
                files: ['package.json', 'yarn.lock', 'webpack.mix.js', 'resources/assets/**'],
                'yarn-run': {
                    command: 'production',
                    output_dir: 'public'
                },
                root: 'public',
                merge: 'overlay'
            });
            expect(Object.keys(result)).toEqual([
                'after', 'before', 'files', 'input', 'merge', 'output', 'package', 'root', 'yarn-run'
            ]);
            expect(Object.keys(result['yarn-run'])).toEqual(['command', 'output_dir']);
        });

        test('sorts helm lens spec with namespace_fill boolean', () => {
            const result = deepSortKeys({
                container: 'ghcr.io/hologit/lenses/helm3@sha256:xyz',
                input: 'aabbccdd',
                output: null,
                before: null,
                after: null,
                root: 'my-frontend',
                files: '**',
                merge: 'replace',
                helm: {
                    namespace: 'my-app',
                    release_name: 'my-frontend',
                    namespace_fill: true,
                    chart_path: 'helm-chart',
                    value_files: ['release-values.yaml']
                }
            });
            expect(Object.keys(result.helm)).toEqual([
                'chart_path', 'namespace', 'namespace_fill', 'release_name', 'value_files'
            ]);
            expect(result.helm.namespace_fill).toBe(true);
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
