// const path = require('path');


const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');
const Studio = require('./Studio.js');


class Lens extends Configurable {

    constructor ({ projection, name }) {
        super(...arguments);

        this.projection = projection;
        this.name = name;

        Object.freeze(this);
    }

    getKind () {
        return 'hololens';
    }

    getConfigPath () {
        return `.holo/lenses/${this.name}.toml`;
    }

    getRepo () {
        return this.projection.repo;
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
        const root = input.root == '.' ? this.projection.output : await this.projection.output.getSubtree(input.root);

        // merge input root into tree with any filters applied
        const tree = this.projection.repo.createTree();
        await tree.merge(root, {
            files: input.files
        });

        return tree;
    }

    async buildSpec (inputTree) {
        const studio = await Studio.get(this.projection.repo.gitDir);
        // const hab = await Studio.getHab();
        const config = await this.getCachedConfig();
        const { package: packageQuery } = config;

        // const setupOutput = await studio.exec('hab', 'pkg', 'install', 'core/hab-plan-build');
        // const originOutput = await studio.exec('hab', 'origin', 'key', 'generate', 'holo');
        // const buildOutput = await studio.habExec('core/hab-plan-build', 'hab-plan-build', '/src/lenses/compass');

        // TODO: use depot API to do this without studio
        let packageIdent = await studio.getPackage(packageQuery);

        if (!packageIdent) {
            throw new Error(`could not find habitat package for ${packageQuery}`);
        }

        // build spec
        const data = {
            ...config,
            package: packageIdent,
            input: await inputTree.write(),
            output: null
        };


        // write spec and return packet
        return {
            ...await SpecObject.write(this.projection.repo, 'lens', data),
            data
        };
    }

    async execute (specHash) {
        const studio = await Studio.get(this.projection.repo.gitDir);

        const output = await studio.holoExec('lens', 'exec', specHash);

        // save spec output
        // await repo.git.updateRef(specRef, lensedTreeHash);

        return output;
    }

}

module.exports = Lens;
