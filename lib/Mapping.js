const path = require('path');


const Configurable = require('./Configurable.js');


const configCache = new WeakMap();


class Mapping extends Configurable {

    constructor ({ branch, key }) {
        super(...arguments);

        this.branch = branch;
        this.key = key;

        Object.freeze(this);
    }

    getKind () {
        return 'holomapping';
    }

    getConfigPath () {
        return `.holo/branches/${this.branch.name}/${this.key}.toml`;
    }

    getRepo () {
        return this.branch.repo;
    }

    async getConfig () {
        const config = await super.getConfig();

        if (!config.files) {
            throw new Error(`holomapping has no files defined: ${this.key}`);
        }

        const localName = path.basename(this.key);

        config.holosource = config.holosource || localName.replace(/^_/, '');
        config.layer = config.layer || config.holosource;
        config.root = path.join('.', config.root || '.', '.');
        config.files = typeof config.files == 'string' ? [config.files] : config.files;
        config.output = path.join(path.dirname(this.key), localName[0] == '_' ? '.' : localName, config.output || '.', '.');

        if (config.before) {
            config.before = typeof config.before == 'string' ? [config.before] : config.before;
        }

        if (config.after) {
            config.after = typeof config.after == 'string' ? [config.after] : config.after;
        }

        return config;
    }

    async getCachedConfig () {
        const cachedConfig = configCache.get(this);

        if (cachedConfig) {
            return cachedConfig;
        }

        const config = await this.getConfig();
        configCache.set(this, config);
        return config;
    }

    async writeConfig () {
        await super.writeConfig(...arguments);
        configCache.delete(this);
    }
}

module.exports = Mapping;
