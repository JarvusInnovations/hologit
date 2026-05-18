/**
 * ProjectionPlan Integration Tests
 *
 * Tests the fluent builder API for programmatic git tree composition
 * without .holo/ TOML declarations in source repositories.
 */

const GitSandbox = require('../helpers/git-sandbox.js');
const Projection = require('../../lib/Projection.js');
const ProjectionPlan = require('../../lib/ProjectionPlan.js');

describe('ProjectionPlan', () => {

    describe('basic composition', () => {
        let sandbox, sourceA, sourceB;

        beforeEach(async () => {
            sandbox = await GitSandbox.create();

            // Create two source repos
            sourceA = await GitSandbox.create();
            await sourceA.addFile('routes/api/people/index.ts', 'export function GET() { return "from-a" }');
            await sourceA.addFile('config/site.config.ts', 'export default { title: "Source A" }');
            await sourceA.addFile('readme.txt', 'source a readme');
            await sourceA.commit('init source-a');

            sourceB = await GitSandbox.create();
            await sourceB.addFile('routes/api/sections/index.ts', 'export function GET() { return "sections" }');
            await sourceB.addFile('models/Section.ts', 'export interface Section { id: number }');
            await sourceB.commit('init source-b');
        });

        afterEach(async () => {
            await sandbox.cleanup();
            await sourceA.cleanup();
            await sourceB.cleanup();
        });

        test('composes two sources into one tree', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('source-a', { url: sourceA.dir, ref: 'refs/heads/main' });
            plan.addLayer('source-b', { url: sourceB.dir, ref: 'refs/heads/main' }, { after: ['source-a'] });

            const treeHash = await plan.project();

            const files = await sandbox.listTree(treeHash);
            expect(files).toContain('routes/api/people/index.ts');
            expect(files).toContain('routes/api/sections/index.ts');
            expect(files).toContain('config/site.config.ts');
            expect(files).toContain('models/Section.ts');
            expect(files).toContain('readme.txt');
        });

        test('returns a valid git tree hash', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('source-a', { url: sourceA.dir, ref: 'refs/heads/main' });

            const treeHash = await plan.project();

            expect(treeHash).toMatch(/^[0-9a-f]{40}$/);
        });

        test('supports fluent chaining', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);

            const result = plan
                .addLayer('source-a', { url: sourceA.dir, ref: 'refs/heads/main' })
                .addLayer('source-b', { url: sourceB.dir, ref: 'refs/heads/main' }, { after: ['source-a'] });

            expect(result).toBe(plan);
        });
    });

    describe('layer override semantics', () => {
        let sandbox, base, overlay;

        beforeEach(async () => {
            sandbox = await GitSandbox.create();

            base = await GitSandbox.create();
            await base.addFile('routes/api/people/index.ts', 'GET from base');
            await base.addFile('routes/health/index.ts', 'health from base');
            await base.addFile('config/site.config.ts', 'base config');
            await base.commit('init base');

            overlay = await GitSandbox.create();
            await overlay.addFile('routes/api/people/index.ts', 'GET from overlay');
            await overlay.addFile('config/site.config.ts', 'overlay config');
            await overlay.commit('init overlay');
        });

        afterEach(async () => {
            await sandbox.cleanup();
            await base.cleanup();
            await overlay.cleanup();
        });

        test('higher layer overrides files at same path', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('base', { url: base.dir, ref: 'refs/heads/main' });
            plan.addLayer('overlay', { url: overlay.dir, ref: 'refs/heads/main' }, { after: ['base'] });

            const treeHash = await plan.project();

            const content = await sandbox.readFromTree(treeHash, 'routes/api/people/index.ts');
            expect(content).toBe('GET from overlay');
        });

        test('non-overridden files from base are preserved', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('base', { url: base.dir, ref: 'refs/heads/main' });
            plan.addLayer('overlay', { url: overlay.dir, ref: 'refs/heads/main' }, { after: ['base'] });

            const treeHash = await plan.project();

            const content = await sandbox.readFromTree(treeHash, 'routes/health/index.ts');
            expect(content).toBe('health from base');
        });

        test('config files override by same path', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('base', { url: base.dir, ref: 'refs/heads/main' });
            plan.addLayer('overlay', { url: overlay.dir, ref: 'refs/heads/main' }, { after: ['base'] });

            const treeHash = await plan.project();

            const content = await sandbox.readFromTree(treeHash, 'config/site.config.ts');
            expect(content).toBe('overlay config');
        });
    });

    describe('additive directories (config.d pattern)', () => {
        let sandbox, skeleton, product;

        beforeEach(async () => {
            sandbox = await GitSandbox.create();

            skeleton = await GitSandbox.create();
            await skeleton.addFile('config/search.config.d/people.ts', 'people search config');
            await skeleton.addFile('events/models/Person/afterSave/01-log.ts', 'log handler');
            await skeleton.commit('init skeleton');

            product = await GitSandbox.create();
            await product.addFile('config/search.config.d/sections.ts', 'sections search config');
            await product.addFile('events/models/Person/afterSave/10-sync.ts', 'sync handler');
            await product.commit('init product');
        });

        afterEach(async () => {
            await sandbox.cleanup();
            await skeleton.cleanup();
            await product.cleanup();
        });

        test('config.d files from both layers are present', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('skeleton', { url: skeleton.dir, ref: 'refs/heads/main' });
            plan.addLayer('product', { url: product.dir, ref: 'refs/heads/main' }, { after: ['skeleton'] });

            const treeHash = await plan.project();

            const files = await sandbox.listTree(treeHash);
            expect(files).toContain('config/search.config.d/people.ts');
            expect(files).toContain('config/search.config.d/sections.ts');
        });

        test('event handlers from both layers accumulate', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('skeleton', { url: skeleton.dir, ref: 'refs/heads/main' });
            plan.addLayer('product', { url: product.dir, ref: 'refs/heads/main' }, { after: ['skeleton'] });

            const treeHash = await plan.project();

            const files = await sandbox.listTree(treeHash);
            expect(files).toContain('events/models/Person/afterSave/01-log.ts');
            expect(files).toContain('events/models/Person/afterSave/10-sync.ts');
        });
    });

    describe('three-layer composition', () => {
        let sandbox, skeleton, product, site;

        beforeEach(async () => {
            sandbox = await GitSandbox.create();

            skeleton = await GitSandbox.create();
            await skeleton.addFile('routes/api/people/index.ts', 'skeleton people');
            await skeleton.addFile('routes/health/index.ts', 'skeleton health');
            await skeleton.addFile('config/site.config.ts', 'skeleton config');
            await skeleton.commit('init skeleton');

            product = await GitSandbox.create();
            await product.addFile('routes/api/people/index.ts', 'product people');
            await product.addFile('routes/api/sections/index.ts', 'product sections');
            await product.commit('init product');

            site = await GitSandbox.create();
            await site.addFile('routes/health/index.ts', 'site health');
            await site.addFile('config/site.config.ts', 'site config');
            await site.addFile('public/logo.svg', '<svg>logo</svg>');
            await site.commit('init site');
        });

        afterEach(async () => {
            await sandbox.cleanup();
            await skeleton.cleanup();
            await product.cleanup();
            await site.cleanup();
        });

        test('composes three layers correctly', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('skeleton', { url: skeleton.dir, ref: 'refs/heads/main' });
            plan.addLayer('product', { url: product.dir, ref: 'refs/heads/main' }, { after: ['skeleton'] });
            plan.addLayer('site', { url: site.dir, ref: 'refs/heads/main' }, { after: ['product'] });

            const treeHash = await plan.project();

            // Product overrides skeleton's people route
            const people = await sandbox.readFromTree(treeHash, 'routes/api/people/index.ts');
            expect(people).toBe('product people');

            // Site overrides skeleton's health route
            const health = await sandbox.readFromTree(treeHash, 'routes/health/index.ts');
            expect(health).toBe('site health');

            // Site overrides skeleton's config
            const config = await sandbox.readFromTree(treeHash, 'config/site.config.ts');
            expect(config).toBe('site config');

            // Product's additions are present
            const sections = await sandbox.readFromTree(treeHash, 'routes/api/sections/index.ts');
            expect(sections).toBe('product sections');

            // Site's additions are present
            const logo = await sandbox.readFromTree(treeHash, 'public/logo.svg');
            expect(logo).toBe('<svg>logo</svg>');
        });
    });

    describe('equivalence with TOML-driven projection', () => {
        let sandbox, sourceA, sourceB;

        beforeEach(async () => {
            sandbox = await GitSandbox.create();

            sourceA = await GitSandbox.create();
            await sourceA.addFile('file-a.txt', 'from source a');
            await sourceA.addFile('shared.txt', 'base version');
            await sourceA.commit('init source-a');

            sourceB = await GitSandbox.create();
            await sourceB.addFile('file-b.txt', 'from source b');
            await sourceB.addFile('shared.txt', 'overlay version');
            await sourceB.commit('init source-b');
        });

        afterEach(async () => {
            await sandbox.cleanup();
            await sourceA.cleanup();
            await sourceB.cleanup();
        });

        test('produces identical tree hash to TOML-driven projection', async () => {
            // Set up TOML-driven projection in sandbox
            await sandbox.initHolo({ name: 'test' });
            await sandbox.addSource('source-a', { url: sourceA.dir, ref: 'refs/heads/main' });
            await sandbox.addSource('source-b', { url: sourceB.dir, ref: 'refs/heads/main' });
            await sandbox.addBranch('composed', {
                '_source-a': { holosource: 'source-a', files: '**' },
                '_source-b': { holosource: 'source-b', files: '**', after: ['source-a'] }
            });
            await sandbox.commit('setup holo');

            // Get TOML-driven output
            const workspace = await sandbox.getWorkspace();
            const branch = workspace.getBranch('composed');
            const tomlHash = await Projection.projectBranch(branch, { lens: false });

            // Get plan-driven output
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addLayer('source-a', { url: sourceA.dir, ref: 'refs/heads/main' });
            plan.addLayer('source-b', { url: sourceB.dir, ref: 'refs/heads/main' }, { after: ['source-a'] });
            const planHash = await plan.project();

            expect(planHash).toBe(tomlHash);
        });
    });

    describe('addSource and addMapping separately', () => {
        let sandbox, source;

        beforeEach(async () => {
            sandbox = await GitSandbox.create();

            source = await GitSandbox.create();
            await source.addFile('src/app.js', 'console.log("app")');
            await source.addFile('docs/readme.md', '# Docs');
            await source.addFile('tests/test.js', 'test()');
            await source.commit('init');
        });

        afterEach(async () => {
            await sandbox.cleanup();
            await source.cleanup();
        });

        test('can map a subtree of a source', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addSource('mylib', { url: source.dir, ref: 'refs/heads/main' });
            plan.addMapping('mylib', { files: ['**'], root: 'src', output: 'lib' });

            const treeHash = await plan.project();

            const files = await sandbox.listTree(treeHash);
            expect(files).toContain('lib/app.js');
            expect(files).not.toContain('src/app.js');
            expect(files).not.toContain('docs/readme.md');
        });

        test('can filter files with globs', async () => {
            const repo = await sandbox.getRepo();
            const plan = new ProjectionPlan(repo);
            plan.addSource('mylib', { url: source.dir, ref: 'refs/heads/main' });
            plan.addMapping('mylib', { files: ['src/**', 'docs/**'] });

            const treeHash = await plan.project();

            const files = await sandbox.listTree(treeHash);
            expect(files).toContain('src/app.js');
            expect(files).toContain('docs/readme.md');
            expect(files).not.toContain('tests/test.js');
        });
    });

    describe('error handling', () => {
        test('throws on missing repo', () => {
            expect(() => new ProjectionPlan(null)).toThrow('repo required');
        });
    });
});
