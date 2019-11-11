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
        if (!config.package) {
            throw new Error(`hololens has no package defined: ${this.name}`);
        }

        config.command = config.command || 'lens-tree {{ input }}';

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

        // merge input root into tree with any filters applied
        const tree = this.workspace.getRepo().createTree();
        await tree.merge(root, {
            files: input.files
        });

        return tree;
    }

    async buildSpec (inputTree) {
        const config = await this.getCachedConfig();


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


        // old studio method that might be useful as fallback/debug option
        // const setupOutput = await studio.exec('hab', 'pkg', 'install', 'core/hab-plan-build');
        // const originOutput = await studio.exec('hab', 'origin', 'key', 'generate', 'holo');
        // const buildOutput = await studio.habPkgExec('core/hab-plan-build', 'hab-plan-build', '/src/lenses/compass');
        // const studio = await Studio.get(this.workspace.getRepo().gitDir);
        // let packageIdent = await studio.getPackage(packageQuery);


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
            data
        };
    }

    async executeSpec (specHash, options) {
        return Lens.executeSpec(specHash, {...options, repo: this.workspace.getRepo()});
    }

    static async executeSpec (specHash, { refresh=false, save=true, repo=null }) {

        // return studio.holoLensExec(specHash);

        // TODO: run in studio if not in one?
        // TODO: delegate some of this to Studio


        // load holorepo
        if (!repo) {
            repo = await Repo.getFromEnvironment();
        }

        const git = await repo.getGit();


        // ensure the rest runs inside a studio environment
        if (!await Studio.isEnvironmentStudio()) {
            const studio = await Studio.get(repo.gitDir);
            return studio.holoLensExec(specHash);
        }


        // check for existing build
        const specRef = SpecObject.buildRef('lens', specHash);
        if (!refresh) {
            const existingBuildHash = await repo.resolveRef(specRef);

            if (existingBuildHash) {
                return existingBuildHash;
            }
        }


        // load spec
        const specToml = await git.catFile({ p: true }, specHash);
        const {
            holospec: {
                lens: spec
            }
        } = TOML.parse(specToml);


        // assign scratch directory
        const scratchPath = `${process.env.HOLO_SCRATCH||'/hab/cache/hololens'}/${spec.package.split('/').slice(0, 2).join('/')}`;
        await mkdirp(scratchPath);


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
                GIT_DIR: repo.gitDir,
                GIT_WORK_TREE: scratchPath,
                GIT_INDEX_FILE: `${scratchPath}.index`,
                DEBUG: process.env.DEBUG || ''
            }
        );
        logger.debug('lens environment:', env);


        // spawn process and log STDERR
        logger.info(`executing lens command: ${command}`);
        const lensProcess = await hab.pkg('exec', spec.package, ...shellParse(command), {
            $env: env,
            $cwd: scratchPath,
            $spawn: true
        });

        lensProcess.stderr.on('data', data => {
            data.toString().trim().split(/\n/).forEach(
                line => logger.info(`lens: ${line}`)
            )
        });


        // process output
        const lensedTreeHash = await lensProcess.captureOutputTrimmed();

        if (!git.isHash(lensedTreeHash)) {
            throw new Error(`lens "${command}" did not return hash: ${lensedTreeHash}`);
        }


        // save ref to accelerate next projection
        if (save) {
            await git.updateRef(specRef, lensedTreeHash);
        }


        // return tree hash
        return lensedTreeHash;
    }

}

module.exports = Lens;
