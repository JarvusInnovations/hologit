/**
 * Lens v2 Job Protocol Integration Tests
 *
 * Exercises the exec/stdio one-shot lens job protocol
 * (specs/behaviors/lensing.md § Job protocol) against a throwaway v2 lens
 * image built locally from test/fixtures/lens-v2-test. The image is never
 * pushed, which also exercises the local-only branch of the container
 * identity-resolution ladder (#417).
 *
 * The suite skips cleanly when docker is unavailable.
 */

const { execSync } = require('child_process');
const path = require('path');
const TOML = require('@iarna/toml');

const GitSandbox = require('../helpers/git-sandbox.js');
// Repo must load before Lens: Repo → Workspace → Lens is a require cycle, and
// loading Lens first leaves Workspace holding a partial Lens export
require('../../lib/Repo.js');
const Lens = require('../../lib/Lens.js');
const Studio = require('../../lib/Studio.js');
const SpecObject = require('../../lib/SpecObject.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const V2_IMAGE = 'holo-lens-v2-test';
const V1_IMAGE = 'holo-lens-v1-test';

let dockerAvailable = false;
try {
    execSync('docker info', { stdio: 'ignore' });
    dockerAvailable = true;
} catch (err) {
    // docker not available — integration suite will be skipped
}

const describeWithDocker = dockerAvailable ? describe : describe.skip;


describe('Lens container identity resolution ladder', () => {
    let sandbox;

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await sandbox.cleanup();
    });

    test('explicit digest pin is used as-is with no engine/registry lookup', async () => {
        const pinned = `example.com/lenses/test@sha256:${'ab'.repeat(32)}`;

        await sandbox.addFile('file.txt', 'content');
        await sandbox.initHolo({ name: 'lens-test' });
        await sandbox.addFile('.holo/lenses/pinned.toml', TOML.stringify({
            hololens: { container: pinned, command: 'holo-lens-test' }
        }));
        await sandbox.commit('setup');

        const execDockerSpy = jest.spyOn(Studio, 'execDocker');

        const workspace = await sandbox.getWorkspace();
        const lens = workspace.getLens('pinned');
        const spec = await lens.buildSpec(await lens.buildInputTree());

        expect(execDockerSpy).not.toHaveBeenCalled();
        expect(spec.data.container).toBe(pinned);
        expect(spec.data._resolved).toBeNull();

        // bookkeeping marker must not appear in the written spec object
        const specToml = await sandbox.git.catFile({ p: true }, spec.hash);
        expect(specToml).not.toMatch(/_resolved/);
    });
});


describeWithDocker('Lens v2 job protocol', () => {
    let sandbox;
    let repoGit;

    beforeAll(() => {
        // build the throwaway lens images locally (never pushed — exercises
        // the local-only identity resolution branch). The v2 image gets the
        // protocol label at build time; the v1 image is the same build
        // without the label, for fallback-detection tests.
        const dockerfile = 'test/fixtures/lens-v2-test/Dockerfile';
        execSync(`docker build -t ${V2_IMAGE} --label sh.holo.lens.protocol=2 -f ${dockerfile} .`, { cwd: REPO_ROOT, stdio: 'pipe' });
        execSync(`docker build -t ${V1_IMAGE} -f ${dockerfile} .`, { cwd: REPO_ROOT, stdio: 'pipe' });
    }, 300000);

    beforeEach(async () => {
        sandbox = await GitSandbox.create();
    });

    afterEach(async () => {
        jest.restoreAllMocks();

        // shut down git-client's persistent batch subprocesses so jest
        // workers can exit cleanly
        if (repoGit) {
            repoGit.cleanup();
            repoGit = null;
        }

        await sandbox.cleanup();
    });

    async function setupLens (name, hololens) {
        await sandbox.addFile('docs/readme.md', 'hello lens world\n');
        await sandbox.initHolo({ name: 'lens-test' });
        await sandbox.addFile(`.holo/lenses/${name}.toml`, TOML.stringify({ hololens }));
        await sandbox.commit('setup');

        const workspace = await sandbox.getWorkspace();
        repoGit = await workspace.getRepo().getGit();
        return workspace.getLens(name);
    }

    test('local-only image resolves by image ID with _resolved = "local" (#417)', async () => {
        const lens = await setupLens('test', { container: V2_IMAGE, command: 'holo-lens-test' });
        const spec = await lens.buildSpec(await lens.buildInputTree());

        expect(spec.data.container).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(spec.data._resolved).toBe('local');

        const specToml = await sandbox.git.catFile({ p: true }, spec.hash);
        expect(specToml).toMatch(/_resolved = "local"/);
        // deadline is an engine concern and must never enter the spec
        expect(specToml).not.toMatch(/timeout/);
    });

    test('success round-trip: deterministic output tree, verified job refs', async () => {
        const lens = await setupLens('test', { container: V2_IMAGE, command: 'holo-lens-test' });
        const spec = await lens.buildSpec(await lens.buildInputTree());

        const treeHash = await lens.executeSpec(spec.hash, {});

        // lens output: LENSED marker + upper-cased copy of each input file
        const files = await sandbox.listTree(treeHash);
        expect(files).toContain('LENSED');
        expect(files).toContain('docs/readme.md');
        expect(await sandbox.readFromTree(treeHash, 'LENSED')).toBe('lensed');
        expect(await sandbox.readFromTree(treeHash, 'docs/readme.md')).toBe('HELLO LENS WORLD');

        // output ref retained; its first parent is the input wrapper commit
        // (.holospec/lens.toml + input/), whose ref has been cleaned up
        const outputRef = `refs/jobs/${spec.hash}/output`;
        const parentCommit = await sandbox.git.revParse(`${outputRef}^`);
        const parentFiles = await sandbox.listTree(await sandbox.git.getTreeHash(parentCommit));
        expect(parentFiles).toContain('.holospec/lens.toml');
        expect(parentFiles).toContain('input/docs/readme.md');
        await expect(sandbox.git.revParse(`refs/jobs/${spec.hash}/input`)).rejects.toThrow();

        // result cached at the spec-keyed ref
        const specRef = SpecObject.buildRef('lens', spec.hash);
        expect(await sandbox.git.getTreeHash(specRef, { verify: false })).toBe(treeHash);
    });

    test('lens failure surfaces structured error with exit code and log', async () => {
        const lens = await setupLens('fail', { container: V2_IMAGE, command: 'holo-lens-fail' });
        const spec = await lens.buildSpec(await lens.buildInputTree());

        expect.assertions(4);
        try {
            await lens.executeSpec(spec.hash, {});
        } catch (err) {
            expect(err.code).toBe('ELENSFAILED');
            expect(err.exitCode).toBe(3);
            expect(err.log).toMatch(/something went boom/);
            expect(err.message).toMatch(/exit code 3/);
        }
    });

    test('job deadline kills the container without leaking it', async () => {
        const lens = await setupLens('slow', { container: V2_IMAGE, command: 'sleep 300', timeout: 3 });
        const spec = await lens.buildSpec(await lens.buildInputTree());

        const started = Date.now();
        await expect(lens.executeSpec(spec.hash, {})).rejects.toMatchObject({
            code: 'ELENSTIMEOUT'
        });
        expect(Date.now() - started).toBeLessThan(15000);

        // the labeled job container must be gone
        const leaked = execSync(`docker ps -a --filter label=sh.holo.lens.job=${spec.hash} --format '{{.Names}}'`)
            .toString().trim();
        expect(leaked).toBe('');
    }, 30000);

    test('unlabeled image falls back to the v1 transport', async () => {
        const lens = await setupLens('legacy', { container: V1_IMAGE, command: 'holo-lens-test' });
        const inputTree = await lens.buildInputTree();
        const inputTreeHash = await inputTree.write();
        const spec = await lens.buildSpec(inputTree);

        const v1Spy = jest.spyOn(Lens, 'executeSpecForContainerV1').mockResolvedValue(inputTreeHash);
        const v2Spy = jest.spyOn(Lens, 'executeSpecForContainerV2');

        const treeHash = await lens.executeSpec(spec.hash, { save: false });

        expect(v1Spy).toHaveBeenCalledTimes(1);
        expect(v2Spy).not.toHaveBeenCalled();
        expect(treeHash).toBe(inputTreeHash);
    });

    test('second execution is a cache hit and never touches docker', async () => {
        const lens = await setupLens('test', { container: V2_IMAGE, command: 'holo-lens-test' });
        const spec = await lens.buildSpec(await lens.buildInputTree());

        const firstHash = await lens.executeSpec(spec.hash, {});

        const containerSpy = jest.spyOn(Lens, 'executeSpecForContainer');
        const dockerSpy = jest.spyOn(Studio, 'spawnDockerJob');

        const secondHash = await lens.executeSpec(spec.hash, {});

        expect(secondHash).toBe(firstHash);
        expect(containerSpy).not.toHaveBeenCalled();
        expect(dockerSpy).not.toHaveBeenCalled();
    });
});
