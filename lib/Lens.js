const axios = require('axios');


const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');
const Studio = require('./Studio.js');


const logger = require('./logger');


class Lens extends Configurable {

    constructor ({ workspace, name }) {
        if (!workspace) {
            throw new Error('workspace required');
        }

        if (!name) {
            throw new Error('name required');
        }

        super(...arguments);

        this.name = name;

        Object.freeze(this);
    }

    getKind () {
        return 'hololens';
    }

    getConfigPath () {
        return `.holo/lenses/${this.name}.toml`;
    }

    async getConfig () {
        const config = await super.getConfig();

        // process lens configuration
        if (!config.package) {
            throw new Error(`hololens has no package defined: ${this.name}`);
        }

        config.command = config.command || 'lens-tree {{ input }}';


        // process and normalize input configuration
        if (!config.input || !config.input.files) {
            throw new Error(`hololens has no input.files defined: ${this.name}`);
        }

        config.input.files = typeof config.input.files == 'string' ? [config.input.files] : config.input.files;
        config.input.root = config.input.root || '.';

        if (config.input.before) {
            config.input.before =
                typeof config.input.before == 'string'
                    ? [config.input.before]
                    : config.input.before;
        }

        if (config.input.after) {
            config.input.after =
                typeof config.input.after == 'string'
                    ? [config.input.after]
                    : config.input.after;
        }


        // process and normalize output configuration
        config.output = config.output || {};
        config.output.root = config.output.root || config.input.root;
        config.output.merge = config.output.merge || 'overlay';

        return config;
    }

    async getSpec () {
        debugger;
    }

    async buildInputTree () {
        const { input } = await this.getCachedConfig();
        const root = input.root == '.' ? this.workspace.root : await this.workspace.root.getSubtree(input.root);

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

            pkgIdent = pkgIdentArray.join('/');
        } catch (err) {
            // check for local package
            if (err.response.status == 404) {
                const packageQuery = [pkgOrigin, pkgName];

                if (pkgVersion) {
                    packageQuery.push(pkgVersion);

                    if (pkgBuild) {
                        packageQuery.push(pkgBuild);
                    }
                }

                logger.warn(`lens package ${packageQuery.join('/')} not found in habitat depot, falling back to local install...`);

                const studio = await Studio.get(this.workspace.getRepo().gitDir);
                pkgIdent = await studio.getPackage(packageQuery.join('/'));
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
            output: null
        };


        // write spec and return packet
        return {
            ...await SpecObject.write(this.workspace.getRepo(), 'lens', data),
            data
        };
    }

    async execute (specHash) {
        const studio = await Studio.get(this.workspace.getRepo().gitDir);

        return studio.holoExec('lens', 'exec', specHash);
    }

}

module.exports = Lens;
