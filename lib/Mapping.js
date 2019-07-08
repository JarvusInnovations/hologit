const path = require('path');


const Configurable = require('./Configurable.js');


class Mapping extends Configurable {

    constructor ({ branch, key }) {
        if (!branch) {
            throw new Error('branch required');
        }

        if (!key) {
            throw new Error('key required');
        }

        super(...arguments);

        this.branch = branch;
        this.key = key;

        Object.freeze(this);
    }

    getWorkspace () {
        return this.branch.workspace;
    }

    getKind () {
        return 'holomapping';
    }

    getConfigPath () {
        return `.holo/branches/${this.branch.name}/${this.key}.toml`;
    }

    async getConfig () {
        const config = await super.getConfig();

        if (!config.files) {
            throw new Error(`holomapping has no files defined: ${this.key}`);
        }

        const basename = path.basename(this.key);
        const localName = basename.replace(/^_/, '');

        if (!config.holosource) {
            config.holosource = localName;
        } else if (config.holosource.substr(0, 2) == '=>') {
            config.holosource = localName + config.holosource;
        }

        config.layer = config.layer || config.holosource;
        config.root = path.join('.', config.root || '.', '.');
        config.files = typeof config.files == 'string' ? [config.files] : config.files;
        config.output = path.join(path.dirname(this.key), basename[0] == '_' ? '.' : basename, config.output || '.', '.');

        if (config.before) {
            config.before = typeof config.before == 'string' ? [config.before] : config.before;
        }

        if (config.after) {
            config.after = typeof config.after == 'string' ? [config.after] : config.after;
        }

        return config;
    }
}

module.exports = Mapping;
