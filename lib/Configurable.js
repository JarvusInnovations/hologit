const TOML = require('@iarna/toml');


const configCache = new WeakMap();


class Object {

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

    async writeConfig (config, writeOptions = {}) {
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
        const config = await this.readConfig();

        if (!config) {
            throw new Error(`${this.getKind()} config does not exist, initialize with \`git holo init\``);
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
}


module.exports = Object;
