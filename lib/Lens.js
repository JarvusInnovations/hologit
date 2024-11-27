const axios = require('axios');
const TOML = require('@iarna/toml');
const handlebars = require('handlebars');
const mkdirp = require('mz-modules/mkdirp');
const shellParse = require('shell-quote-word');
const squish = require('object-squish');

const Repo = require('./Repo.js');
const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');
const Studio = require('./Studio.js');

const logger = require('./logger');


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

    async buildSpecForContainer (inputTree, config) {
        const { container: containerQuery } = config;

        // get Docker connection
        const docker = await Studio.getDocker();

        // check if image exists locally first
        let imageHash;
        try {
            const image = docker.getImage(containerQuery);
            const imageInfo = await image.inspect();
            imageHash = imageInfo.Id;
            logger.info(`found local image: ${containerQuery}@${imageHash}`);
        } catch (err) {
            // image doesn't exist locally or can't be inspected, try pulling
            logger.info(`pulling image: ${containerQuery}`);

            let pullStream;
            try {
                pullStream = await docker.pull(containerQuery);
            } catch (err) {
                throw new Error(`failed to pull container image ${containerQuery}: ${err.message}`);
            }

            // get image hash from pull operation
            const { imageHash: pulledHash } = await new Promise((resolve, reject) => {
                let lastStatus, imageHash;

                docker.modem.followProgress(
                    pullStream,
                    (err, output) => {
                        if (err) {
                            reject(err);
                        } else {
                            // get the image hash from the last output entry
                            const lastEntry = output[output.length - 1];
                            imageHash = lastEntry.digest;
                            resolve({ lastStatus, imageHash, output });
                        }
                    },
                    event => {
                        if (event.status != lastStatus) {
                            logger.info(`docker pull: ${event.status}`);
                            lastStatus = event.status;
                        }
                    }
                );
            });

            imageHash = pulledHash;
        }

        if (!imageHash) {
            throw new Error(`failed to get hash for container image ${containerQuery}`);
        }

        // build spec
        const data = {
            ...config,
            container: `${containerQuery.replace(/:.*$/, '')}@${imageHash}`,
            input: await inputTree.write(),
            output: null,
            before: null,
            after: null
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

    async executeSpec (specType, specHash, options) {
        return Lens.executeSpec(specType, specHash, {...options, repo: this.workspace.getRepo()});
    }

    static async executeSpec (specType, specHash, options) {
        const { refresh=false, cacheFrom=null, cacheTo=null, save=true } = options;


        // load holorepo
        const repo = options.repo || await Repo.getFromEnvironment();
        const git = await repo.getGit();


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
            lensedTreeHash = await Lens.executeSpecForContainer(repo, specHash);
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

    static async executeSpecForContainer (repo, specHash) {
        const git = await repo.getGit();
        const docker = await Studio.getDocker();

        // read and parse spec file
        const specToml = await git.catFile({ p: true }, specHash);
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

        // extract repository and hash from container string
        const containerMatch = spec.container.match(/^.+@sha256:([a-f0-9]{64})$/);
        if (!containerMatch) {
            throw new Error(`Invalid container format: ${spec.container}`);
        }
        const [, sha256Hash] = containerMatch;

        // start container
        const container = await docker.createContainer({
            Image: sha256Hash,
            AttachStdin: false,
            AttachStdout: true,
            AttachStderr: true,
            ExposedPorts: {
                '9000/tcp': {}
            },
            HostConfig: {
                PortBindings: {
                    '9000/tcp': [{ HostPort: '9000' }]
                }
            }
        });

        try {
            logger.info('starting container');
            await container.start();

            // wait for port 9000 to be available
            let attempts = 0;
            const maxAttempts = 30;
            const waitTime = 1000; // 1 second

            while (attempts < maxAttempts) {
                try {
                    const containerInfo = await container.inspect();
                    if (containerInfo.State.Running) {
                        // check if port 9000 is listening
                        const execResult = await container.exec({
                            Cmd: ['nc', '-z', 'localhost', '9000'],
                            AttachStdout: true,
                            AttachStderr: true
                        });
                        const stream = await execResult.start();
                        const output = await new Promise((resolve) => {
                            let data = '';
                            stream.on('data', chunk => data += chunk);
                            stream.on('end', () => resolve(data));
                        });

                        if (!output) { // nc exits with no output when connection succeeds
                            break;
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
            logger.info('pushing and executing job');
            await git.push(`http://localhost:9000/`, `${commitHash}:refs/heads/lens-input`);

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
            try {
                await container.stop();
                await container.remove();
            } catch (err) {
                logger.warn(`Failed to cleanup container: ${err.message}`);
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
            const specToml = await git.catFile({ p: true }, specHash);
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
