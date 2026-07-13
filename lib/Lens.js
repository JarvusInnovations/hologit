const crypto = require('crypto');
const os = require('os');
const path = require('path');

const axios = require('axios');
const TOML = require('@iarna/toml');
const fs = require('mz/fs');
const handlebars = require('handlebars');
const mkdirp = require('mz-modules/mkdirp');
const shellParse = require('shell-quote-word');
const squish = require('object-squish');

const Repo = require('./Repo.js');
const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');
const Studio = require('./Studio.js');

const logger = require('./logger');


// default job deadline in seconds, overridable via lens config `timeout`
const DEFAULT_JOB_TIMEOUT = 600;

// OCI image label marking a lens image as implementing the v2 job protocol
const PROTOCOL_LABEL = 'sh.holo.lens.protocol';


class Lens extends Configurable {

    constructor ({ workspace, name, path = null }) {
        if (!workspace) {
            throw new Error('workspace required');
        }

        if (!name) {
            throw new Error('name required');
        }

        super(...arguments);

        this.name = name;
        this.path = path || `.holo/lenses/${name}.toml`;

        Object.freeze(this);
    }

    getKind () {
        return 'hololens';
    }

    getConfigPath () {
        return this.path;
    }

    async getConfig () {
        const config = await super.getConfig();

        // process lens configuration
        if (config.package) {
            config.command = config.command || 'lens-tree {{ input }}';
        }

        if (config.before) {
            config.before =
                typeof config.before == 'string'
                    ? [config.before]
                    : config.before;
        }

        if (config.after) {
            config.after =
                typeof config.after == 'string'
                    ? [config.after]
                    : config.after;
        }

        // process and normalize input configuration
        config.input = config.input || {};
        config.input.files = typeof config.input.files == 'string' ? [config.input.files] : config.input.files || ['**'];
        config.input.root = config.input.root || '.';

        // process and normalize output configuration
        config.output = config.output || {};
        config.output.root = config.output.root || config.input.root;
        config.output.merge = config.output.merge || 'overlay';

        // check for lens data tree
        const dataTree = await this.getWorkspace().root.getChild(this.path.replace(/\.toml$/, ''));
        if (dataTree && dataTree.isTree) {
            config.data = await dataTree.getHash();
        }

        return config;
    }

    async buildInputTree (inputRoot = this.workspace.root) {
        const { input } = await this.getCachedConfig();
        const root = input.root == '.' ? inputRoot : await inputRoot.getSubtree(input.root);

        if (!root) {
            throw new Error(`Could not resolve path "${input.root}" within input tree ${await inputRoot.getHash()}`);
        }

        // merge input root into tree with any filters applied
        const tree = this.workspace.getRepo().createTree();
        await tree.merge(root, {
            files: input.files
        });

        return tree;
    }

    async buildSpec (inputTree) {
        const config = await this.getCachedConfig();

        if (config.container) {
            return this.buildSpecForContainer(inputTree, config);
        } else if (config.package) {
            return this.buildSpecForHabitatPackage(inputTree, config);
        } else {
            throw new Error(`hololens has no package or container defined: ${this.name}`);
        }
    }

    /**
     * Resolve a configured container reference to a stable execution identity,
     * per the resolution ladder in specs/behaviors/lensing.md:
     *
     *   1. Explicit digest pin in config — used as-is, no lookup.
     *   2. Local engine lookup — the RepoDigests digest of a locally present
     *      image matching the tag; if the image is local but has never been
     *      pushed (no repo digest — #417), its image ID is used with an
     *      explicit `_resolved = "local"` marker (honestly non-portable).
     *      Underscore-prefixed spec keys are engine bookkeeping: lens
     *      transforms must ignore them and SDK env conversions exclude them.
     *   3. Registry lookup — manifest digest via the registry.
     *
     * @returns {Promise<{container: string, resolved?: string}>}
     */
    async resolveContainerIdentity (containerQuery) {
        // 1. explicit digest pin — no lookup performed
        if (/@sha256:[a-f0-9]{64}$/.test(containerQuery)) {
            logger.info(`using digest-pinned container identity: ${containerQuery}`);
            return { container: containerQuery };
        }

        // 2. local engine lookup
        try {
            const output = await Studio.execDocker(['image', 'inspect', containerQuery]);
            const [info] = JSON.parse(output);
            const repoName = containerQuery.replace(/:.*$/, '');
            const repoDigests = info.RepoDigests || [];
            const matchingDigest =
                repoDigests.find(digest => digest.startsWith(`${repoName}@`))
                || repoDigests[0];

            if (matchingDigest) {
                logger.info(`resolved container identity from local image: ${matchingDigest}`);
                return { container: matchingDigest };
            }

            // local-only image, never pushed (#417): use image ID, marked local
            logger.info(`resolved local-only container identity: ${info.Id} (${containerQuery})`);
            return { container: info.Id, resolved: 'local' };
        } catch (err) {
            // image not present locally, fall through to registry lookup
        }

        // 3. registry lookup
        const { hash: imageHash } = await this.getImageHash(containerQuery);
        return { container: `${containerQuery.replace(/:.*$/, '')}@${imageHash}` };
    }

    async getImageHash (containerQuery) {
        // Get manifest digest from registry without pulling.
        // This is the only identifier that is consistent across all machines
        // and Docker storage backends (graphdriver vs containerd-snapshotter).
        let manifestDigest;
        try {
            logger.info(`querying registry for manifest digest: ${containerQuery}`);
            const output = await Studio.execDocker([
                'buildx', 'imagetools', 'inspect', '--format', '{{json .}}', containerQuery
            ]);
            const info = JSON.parse(output);
            manifestDigest = info.manifest.digest;
        } catch (err) {
            throw new Error(`failed to get manifest digest for container image ${containerQuery}: ${err.message}`);
        }

        if (!manifestDigest) {
            throw new Error(`no manifest digest found for ${containerQuery}`);
        }

        // Check if already available locally by digest reference
        const repoName = containerQuery.replace(/:.*$/, '');
        let isLocal = false;
        try {
            await Studio.execDocker(['inspect', `${repoName}@${manifestDigest}`]);
            isLocal = true;
        } catch (err) {
            // not local
        }

        logger.info(`image ${containerQuery} manifest digest: ${manifestDigest} (local: ${isLocal})`);
        return { hash: manifestDigest, isLocal };
    }

    async buildSpecForContainer (inputTree, config) {
        const { container: containerQuery } = config;

        // resolve container identity via the resolution ladder
        // (digest pin → local lookup → registry)
        const identity = await this.resolveContainerIdentity(containerQuery);

        // build spec
        const data = {
            ...config,
            container: identity.container,
            _resolved: identity.resolved || null, // engine bookkeeping (underscore prefix); null values are omitted from spec TOML
            input: await inputTree.write(),
            output: null,
            before: null,
            after: null,
            timeout: null // execution deadline cannot change output, must stay out of spec hash
        };

        // write spec and return packet
        return {
            ...await SpecObject.write(this.workspace.getRepo(), 'lens', data),
            data,
            type: 'container'
        };
    }

    async buildSpecForHabitatPackage (inputTree, config) {
        // determine current package version
        const { package: packageQuery } = config;
        const [pkgOrigin, pkgName, pkgVersion, pkgBuild] = packageQuery.split('/');


        // check local package version if within studio environment
        let localPkgIdent, localPkgBuild;

        if (await Studio.isEnvironmentStudio()) {
            const studio = await Studio.get(this.workspace.getRepo().gitDir);
            localPkgIdent = await studio.getPackage(packageQuery);

            if (localPkgIdent) {
                [,,, localPkgBuild] = localPkgIdent.split('/');
            }
        }


        // look up package via BLDR API
        let pkgIdent;
        try {
            const infoUrl = [
                'https://bldr.habitat.sh/v1/depot/channels',
                pkgOrigin,
                'stable/pkgs',
                pkgName
            ];
            if (pkgVersion) {
                infoUrl.push(pkgVersion);
            }
            infoUrl.push(pkgBuild || 'latest');

            const {
                data: {
                    ident_array: pkgIdentArray
                }
            } = await axios.get(infoUrl.join('/'), { params: { target: 'x86_64-linux' } });

            if (!pkgIdentArray) {
                throw new Error('data.ident_array missing from response');
            }

            if (localPkgBuild && localPkgBuild > pkgIdentArray[3]) {
                logger.warn(`local lens package ${localPkgIdent} is newer than in depot, using local...`);
                pkgIdent = localPkgIdent;
            } else {
                pkgIdent = pkgIdentArray.join('/');
            }
        } catch (err) {
            // check for local package
            if (localPkgIdent) {
                logger.warn(`lens package ${packageQuery} could not be found in habitat depot, falling back to local install...`);
                pkgIdent = localPkgIdent;
            } else {
                throw new Error(`could not find habitat package for ${packageQuery}: ${err.message}`);
            }
        }


        // build spec
        const data = {
            ...config,
            package: pkgIdent,
            input: await inputTree.write(),
            output: null,
            before: null,
            after: null
        };


        // write spec and return packet
        return {
            ...await SpecObject.write(this.workspace.getRepo(), 'lens', data),
            data,
            type: 'habitat'
        };
    }

    async executeSpec (specHash, options) {
        // job deadline comes from lens config (with engine default), never from
        // the spec object — it cannot change the output
        const { timeout } = await this.getCachedConfig();
        return Lens.executeSpec(specHash, { timeout, ...options, repo: this.workspace.getRepo() });
    }

    static async executeSpec (specHash, options) {
        const { refresh=false, cacheFrom=null, cacheTo=null, save=true } = options;


        // load holorepo
        const repo = options.repo || await Repo.getFromEnvironment();
        const git = await repo.getGit();


        // determine spec type from content
        const specToml = await git.$getBlob(specHash);
        const { holospec: { lens: spec } } = TOML.parse(specToml);
        const specType = spec.container ? 'container' : spec.package ? 'habitat' : null;

        if (!specType) {
            throw new Error(`unable to determine spec type: spec has neither container nor package field`);
        }


        // check for existing build
        const specRef = SpecObject.buildRef('lens', specHash);
        if (!refresh) {
            let existingBuildHash = await git.getTreeHash(specRef, { verify: false });

            if (existingBuildHash) {
                logger.info(`found existing output tree matching holospec(${specHash})`);

                if (cacheTo) {
                    await _cacheResultTo(repo, specRef, cacheTo);
                }

                return existingBuildHash;
            }

            if (cacheFrom) {
                existingBuildHash = await _cacheResultFrom(repo, specRef, cacheFrom);

                if (existingBuildHash) {
                    return existingBuildHash;
                }
            }
        }


        // execute lens in container or with habitat package:
        let lensedTreeHash;
        if (specType == 'container') {
            lensedTreeHash = await Lens.executeSpecForContainer(repo, specHash, { timeout: options.timeout });
        } else if (specType == 'habitat') {
            lensedTreeHash = await Lens.executeSpecForHabitatPackage(repo, specHash);
        }

        // save ref to accelerate next projection
        if (save) {
            await git.updateRef(specRef, lensedTreeHash);

            if (cacheTo) {
                await _cacheResultTo(repo, specRef, cacheTo);
            }
        }

        return lensedTreeHash;
    }

    /**
     * Execute a container lens spec, dispatching between the v1 (port-9000
     * git server) and v2 (exec/stdio job protocol) transports based on the
     * image's `sh.holo.lens.protocol` OCI label.
     */
    static async executeSpecForContainer (repo, specHash, options = {}) {
        const git = await repo.getGit();

        // read and parse spec file
        const specToml = await git.$getBlob(specHash);
        const {
            holospec: {
                lens: spec
            }
        } = TOML.parse(specToml);

        const containerRef = spec.container;

        // ensure image is available locally
        if (spec._resolved == 'local') {
            // locally-resolved image (#417): identified by image ID, cannot be pulled
            try {
                await Studio.execDocker(['image', 'inspect', containerRef]);
            } catch (err) {
                throw new Error(`locally-resolved lens image ${containerRef} is not available in the local engine; rebuild the image or update the lens container config`);
            }
        } else {
            if (!containerRef.match(/^.+@sha256:[a-f0-9]{64}$/)) {
                throw new Error(`Invalid container format: ${containerRef}`);
            }

            try {
                await Studio.execDocker(['image', 'inspect', containerRef]);
            } catch (err) {
                // Pull by digest — guarantees we get the exact image version
                // matching the spec that was used for caching
                logger.info(`pulling required image: ${containerRef}`);
                try {
                    await Studio.execDocker(['pull', containerRef], { $relayStdout: true });
                } catch (pullErr) {
                    throw new Error(`failed to pull container image ${containerRef}: ${pullErr.message}`);
                }
            }
        }

        // detect job protocol from image labels
        let labels;
        try {
            labels = JSON.parse(
                await Studio.execDocker(['image', 'inspect', '--format', '{{json .Config.Labels}}', containerRef])
            );
        } catch (err) {
            logger.warn(`could not read labels from image ${containerRef}: ${err.message}`);
        }

        if (labels && labels[PROTOCOL_LABEL] === '2') {
            logger.info(`lens protocol v2 (exec/stdio one-shot): ${containerRef}`);
            return Lens.executeSpecForContainerV2(repo, specHash, { ...options, spec, containerRef });
        }

        logger.info(`lens protocol v1 (port-9000 git server): ${containerRef}`);
        return Lens.executeSpecForContainerV1(repo, specHash);
    }

    /**
     * Execute a container lens spec over the one-shot v2 job protocol
     * (specs/behaviors/lensing.md § Job protocol): pipe a bundle containing
     * `refs/jobs/<spec-hash>/input` (a wrapper commit: `.holospec/lens.toml`
     * + `input/`) to the container over stdin, and read back a bundle
     * containing `refs/jobs/<spec-hash>/output` (success — a commit whose
     * first parent is the input commit) or `refs/jobs/<spec-hash>/error`
     * (failure — a tree with `exit-code` and `log` entries) from stdout.
     */
    static async executeSpecForContainerV2 (repo, specHash, options = {}) {
        const git = await repo.getGit();
        const timeout = options.timeout || DEFAULT_JOB_TIMEOUT;

        // read and parse spec file if not passed through from dispatcher
        let { spec, containerRef } = options;
        if (!spec) {
            ({ holospec: { lens: spec } } = TOML.parse(await git.$getBlob(specHash)));
        }
        if (!containerRef) {
            containerRef = spec.container;
        }

        // build job input wrapper commit: .holospec/lens.toml + input/
        const holospecTree = await git.$putTree([
            { mode: '100644', type: 'blob', hash: specHash, name: 'lens.toml' }
        ]);
        const wrapperTree = await git.$putTree([
            { mode: '40000', type: 'tree', hash: holospecTree, name: '.holospec' },
            { mode: '40000', type: 'tree', hash: spec.input, name: 'input' }
        ]);
        const inputCommitHash = await git.commitTree(wrapperTree, {
            p: [],
            m: `lens job ${specHash}`
        });

        const inputRef = `refs/jobs/${specHash}/input`;
        const outputRef = `refs/jobs/${specHash}/output`;
        const errorRef = `refs/jobs/${specHash}/error`;

        await git.updateRef(inputRef, inputCommitHash);

        const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holo-lens-job-'));
        const containerName = `holo-lens-job-${specHash.substr(0, 12)}-${crypto.randomBytes(4).toString('hex')}`;

        try {
            // bundle the input wrapper commit
            const inputBundlePath = path.join(scratchDir, 'input.bundle');
            await git.bundle('create', inputBundlePath, inputRef);
            const inputBundle = await fs.readFile(inputBundlePath);

            // run one-shot job container: bundle on stdin, bundle on stdout,
            // exit code mirroring; stderr is relayed as logging
            logger.info(`executing lens job ${specHash} (deadline ${timeout}s)`);
            const { code, stdout, stderr, timedOut } = await Studio.spawnDockerJob(
                [
                    'run', '--rm', '--interactive',
                    '--name', containerName,
                    '--label', `sh.holo.lens.job=${specHash}`,
                    containerRef
                ],
                {
                    input: inputBundle,
                    timeoutMs: timeout * 1000,
                    containerName,
                    onStderrLine: line => process.stderr.write(`\x1b[90m${line}\x1b[0m\n`)
                }
            );

            if (timedOut) {
                const timeoutError = new Error(`lens job ${specHash} exceeded its ${timeout}s deadline and was killed`);
                timeoutError.code = 'ELENSTIMEOUT';
                timeoutError.specHash = specHash;
                timeoutError.timeout = timeout;
                throw timeoutError;
            }

            if (!stdout.length) {
                throw new Error(`lens container exited with code ${code} without returning a bundle (transport error)${stderr ? `:\n${stderr}` : ''}`);
            }

            // write returned bundle to disk for fetching (fetch verifies all
            // objects on ingest)
            const resultBundlePath = path.join(scratchDir, 'result.bundle');
            await fs.writeFile(resultBundlePath, stdout);

            if (code === 0) {
                logger.info('fetching result');
                await git.fetch(resultBundlePath, `+${outputRef}:${outputRef}`);

                // verify the output commit's first parent matches our input commit
                const outputParent = await git.revParse(`${outputRef}^`);
                if (outputParent !== inputCommitHash) {
                    throw new Error(`Output commit parent ${outputParent} does not match input commit ${inputCommitHash}`);
                }

                return await git.getTreeHash(outputRef);
            }

            // non-zero exit: expect a structured error bundle
            let exitCode = code, log = null;
            try {
                await git.fetch(resultBundlePath, `+${errorRef}:${errorRef}`);
                exitCode = parseInt(await git.$getBlob(await git.revParse(`${errorRef}:exit-code`)), 10);
                log = await git.$getBlob(await git.revParse(`${errorRef}:log`));
            } catch (fetchErr) {
                throw new Error(`lens container exited with code ${code} without returning a readable error bundle (transport error): ${fetchErr.message}`);
            }

            const lensError = new Error(`lens job ${specHash} failed with exit code ${exitCode}${log ? `:\n${log.trimEnd()}` : ''}`);
            lensError.code = 'ELENSFAILED';
            lensError.specHash = specHash;
            lensError.exitCode = exitCode;
            lensError.log = log;
            throw lensError;
        } finally {
            // input objects stay reachable via the output commit's parent
            // link, so the input ref is transient
            try {
                await git.updateRef({ d: true }, inputRef);
            } catch (err) {
                logger.warn(`failed to clean up ${inputRef}: ${err.message}`);
            }

            await require('fs').promises.rm(scratchDir, { recursive: true, force: true }).catch(
                err => logger.warn(`failed to clean up ${scratchDir}: ${err.message}`)
            );
        }
    }

    /**
     * Execute a container lens spec over the legacy v1 transport: a git
     * server inside the container published on host port 9000. Superseded by
     * the v2 job protocol, retained while published lens images migrate
     * (hologit/lenses#32).
     */
    static async executeSpecForContainerV1 (repo, specHash) {
        const git = await repo.getGit();

        // read and parse spec file
        const specToml = await git.$getBlob(specHash);
        const {
            holospec: {
                lens: spec
            }
        } = TOML.parse(specToml);

        // write commit with input tree and spec content
        const commitHash = await git.commitTree(spec.input, {
            p: [],
            m: specToml
        });

        // use full digest reference (e.g. "ghcr.io/hologit/lenses/shell@sha256:0f8acb01...")
        // for all docker operations — this is the manifest digest, which works
        // consistently across Docker storage backends
        const containerRef = spec.container;
        if (!containerRef.match(/^.+@sha256:[a-f0-9]{64}$/)) {
            throw new Error(`Invalid container format: ${containerRef}`);
        }

        // Ensure image is available locally
        try {
            await Studio.execDocker(['inspect', containerRef]);
        } catch (err) {
            // Pull by digest — guarantees we get the exact image version
            // matching the spec that was used for caching
            logger.info(`pulling required image: ${containerRef}`);
            try {
                await Studio.execDocker(['pull', containerRef], { $relayStdout: true });
            } catch (pullErr) {
                throw new Error(`failed to pull container image ${containerRef}: ${pullErr.message}`);
            }
        }

        // create and start container
        const persistentDebugContainer = process.env.HOLO_DEBUG_PERSIST_CONTAINER;
        let containerId;
        try {
            if (persistentDebugContainer) {
                try {
                    const containerInfo = await Studio.execDocker(['inspect', persistentDebugContainer]);
                    const containerState = JSON.parse(containerInfo)[0].State;

                    if (containerState.Running) {
                        logger.info(`Found running debug container: ${persistentDebugContainer}`);
                        containerId = persistentDebugContainer;
                    }
                } catch (error) {
                    containerId = null;
                }
            }

            // create container
            if (!containerId) {
                containerId = await Studio.execDocker([
                    'create',
                    '-p', '9000:9000',
                    ...(persistentDebugContainer ? ['--name', persistentDebugContainer] : []),
                    ...(process.env.DEBUG ? ['-e', 'DEBUG=1'] : []),
                    containerRef
                ]);
                containerId = containerId.trim();

                logger.info('starting container');
                await Studio.execDocker(['start', containerId]);
            }

            // wait for port 9000 to be available
            let attempts = 0;
            const maxAttempts = 30;
            const waitTime = 1000; // 1 second

            while (attempts < maxAttempts) {
                try {
                    const containerInfo = await Studio.execDocker(['inspect', containerId]);
                    const containerState = JSON.parse(containerInfo)[0].State;

                    if (containerState.Running) {
                        // check if port 9000 is listening
                        try {
                            await Studio.execDocker([
                                'exec',
                                containerId,
                                'nc',
                                '-z',
                                'localhost',
                                '9000'
                            ]);
                            break;
                        } catch (err) {
                            // ignore error and continue waiting
                        }
                    }
                } catch (err) {
                    // ignore error and continue waiting
                }

                await new Promise(resolve => setTimeout(resolve, waitTime));
                attempts++;
            }

            if (attempts >= maxAttempts) {
                throw new Error('Timeout waiting for git server to be ready');
            }

            // push commit to git server
            logger.info(`pushing and executing job: ${commitHash}`);
            await git.push(`http://localhost:9000/`, `${commitHash}:refs/heads/lens-input`, {
                force: true,
                $wait: true,
                $onStderr: (line) => process.stderr.write(`\x1b[90m${line}\x1b[0m\n`)
            });

            // fetch and verify output commit
            const outputRef = `refs/lens-jobs/${specHash}`;
            logger.info('fetching result');
            await git.fetch('http://localhost:9000/', `+refs/heads/lens-input:${outputRef}`);

            // verify the output commit's parent matches our input commit
            const outputParent = await git.revParse(`${outputRef}^`);
            if (outputParent !== commitHash) {
                throw new Error(`Output commit parent ${outputParent} does not match input commit ${commitHash}`);
            }

            return await git.getTreeHash(outputRef);

        } finally {
            // cleanup
            if (containerId && !persistentDebugContainer) {
                try {
                    await Studio.execDocker(['stop', containerId]);
                    await Studio.execDocker(['rm', containerId]);
                } catch (err) {
                    logger.warn(`Failed to cleanup container: ${err.message}`);
                }
            }
        }
    }

    static async executeSpecForHabitatPackage (repo, specHash) {
        const git = await repo.getGit();

        let lensedTreeHash;

        // ensure the rest runs inside a studio environment
        if (!await Studio.isEnvironmentStudio()) {
            const studio = await Studio.get(repo.gitDir);
            lensedTreeHash = await studio.holoLensExec(specHash);

            if (!git.isHash(lensedTreeHash)) {
                throw new Error(`lens-exec "${specHash}" did not return hash: ${lensedTreeHash}`);
            }
        } else {
            // load spec
            const specToml = await git.$getBlob(specHash);
            const {
                holospec: {
                    lens: spec
                }
            } = TOML.parse(specToml);


            // assign scratch directory
            const scratchPath = process.env.HOLO_SCRATCH || '/hab/cache/hololens';
            const specPkgScratchPath = `${process.env.HOLO_SCRATCH||'/hab/cache/hololens'}/${spec.package.split('/').slice(0, 2).join('/')}`;
            await mkdirp(specPkgScratchPath);


            // install lens package
            const hab = await Studio.getHab();
            logger.info(`installing lens package: ${spec.package}`);
            await hab.pkg('install', spec.package);


            // prepare command and environment
            const command = handlebars.compile(spec.command)(spec);
            const env = Object.assign(
                squish(
                    {
                        hololens: { ...spec, spec: specHash }
                    },
                    {
                        seperator: '_',
                        modifyKey: key => key.toUpperCase().replace(/-/g, '_')
                    }
                ),
                {
                    HOME: scratchPath,
                    GIT_DIR: repo.gitDir,
                    GIT_WORK_TREE: specPkgScratchPath,
                    GIT_INDEX_FILE: `${specPkgScratchPath}.index`,
                    DEBUG: process.env.DEBUG || ''
                }
            );
            logger.debug('lens environment: %o', env);


            // spawn process and log STDERR
            logger.info(`executing lens command: ${command}`);
            const lensProcess = await hab.pkg('exec', spec.package, ...shellParse(command), {
                $env: env,
                $cwd: specPkgScratchPath,
                $spawn: true
            });

            lensProcess.stderr.on('data', data => {
                data.toString().trim().split(/\n/).forEach(
                    line => logger.info(`lens: ${line}`)
                )
            });


            // process output
            lensedTreeHash = await lensProcess.captureOutputTrimmed();

            if (!git.isHash(lensedTreeHash)) {
                throw new Error(`lens "${command}" did not return hash: ${lensedTreeHash}`);
            }
        }


        // return tree hash
        return lensedTreeHash;
    }

}

module.exports = Lens;


// private methods
function _getTrackingRef(specRef, remote) {
    return `refs/holo/lens-remotes/${remote}/${specRef.substr(15)}`;
}

async function _cacheResultFrom(repo, specRef, cacheFrom) {
    const git = await repo.getGit();

    try {
        await git.fetch(cacheFrom, `${specRef}:${specRef}`);

        const existingBuildHash = await git.getTreeHash(specRef, { verify: false });

        if (existingBuildHash) {
            logger.info(`fetched cached result from ${cacheFrom}: ${specRef}`);
            await git.updateRef(_getTrackingRef(specRef, cacheFrom), existingBuildHash);
            return existingBuildHash;
        }
    } catch (err) {
        return null;
    }
}


async function _cacheResultTo(repo, specRef, cacheTo) {
    const git = await repo.getGit();
    const trackingSpecRef = _getTrackingRef(specRef, cacheTo);

    if (!await repo.resolveRef(trackingSpecRef)) {
        logger.info(`pushing cached result to ${cacheTo}: ${specRef}`);

        try {
            await git.push(cacheTo, specRef);
        } catch (err) {
            logger.warn(`failed to push cached result to ${cacheTo}: ${err.message}`);
        }

        await git.updateRef(trackingSpecRef, specRef);
    }
}
