const TOML = require('@iarna/toml');


const configCache = new WeakMap();


class Object {

    constructor ({ phantom=null }) {
        if (phantom) {
            this.phantom = phantom;
        }
    }

    async readConfig () {
        const kind = this.getKind();
        const tomlPath = this.getConfigPath();

        let toml;
        try {
            toml = await this.getRepo().readFile(tomlPath);
        } catch (err) {
            return null;
        }

        let parsed;
        try {
            parsed = TOML.parse(toml);
        } catch (err) {
            throw new Error(`could not parse ${tomlPath}: ${err.message}`);
        }

        const config = parsed[kind];
        if (!config) {
            throw new Error(`${kind} config not found in ${tomlPath}`);
        }

        return config;
    }

    async writeConfig (config = this.phantom, writeOptions = {}) {
        const tomlPath = this.getConfigPath();

        let toml;
        try {
            toml = await this.getRepo().readFile(tomlPath);
        } catch (err) {
            toml = null;
        }

        const parsed = toml && TOML.parse(toml) || {};

        parsed[this.getKind()] = config;

        await this.getRepo().writeFile(tomlPath, TOML.stringify(parsed), writeOptions);

        configCache.delete(this);
    }

    async getConfig () {
        const config = this.phantom || await this.readConfig();

        if (!config) {
            throw new Error(`${this.getKind()} config does not exist, initialize with \`git holo init\``);
        }

        return config;
    }

    async getCachedConfig ({ refresh=false } = {}) {
        const cachedConfig = !refresh && configCache.get(this);

        if (cachedConfig) {
            return cachedConfig;
        }

        const config = await this.getConfig(...arguments);
        configCache.set(this, config);
        return config;
    }
}


module.exports = Object;
