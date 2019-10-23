const TOML = require('@iarna/toml');


const configCache = new WeakMap();


class Configurable {

    constructor ({ phantom=null, workspace=null }) {
        if (phantom) {
            this.phantom = phantom;
        }

        if (workspace) {
            this.workspace = workspace;
        }
    }

    getWorkspace () {
        return this.workspace;
    }

    getRepo() {
        return this.getWorkspace().root.repo;
    }

    async readConfig () {
        const tomlPath = this.getConfigPath();
        if (!tomlPath) {
            return null;
        }

        const tomlFile = await this.getWorkspace().root.getChild(tomlPath);
        if (!tomlFile) {
            return null;
        }

        let parsed;
        try {
            parsed = TOML.parse(await tomlFile.read());
        } catch (err) {
            throw new Error(`could not parse ${tomlPath}: ${err.message}`);
        }

        const kind = this.getKind();
        const config = parsed[kind];
        if (!config) {
            throw new Error(`${kind} config not found in ${tomlPath}`);
        }

        return config;
    }

    async writeConfig (config = this.phantom) {
        const tomlPath = this.getConfigPath();
        if (!tomlPath) {
            throw new Error('cannot write config for class with no config path');
        }

        const workspace = this.getWorkspace();
        const tomlFile = await workspace.root.getChild(tomlPath);

        const parsed = tomlFile && TOML.parse(await tomlFile.read()) || {};
        parsed[this.getKind()] = config;

        await workspace.root.writeChild(tomlPath, TOML.stringify(parsed));

        configCache.delete(this);
    }

    async getConfig () {
        const config = this.phantom || await this.readConfig();

        if (!config) {
            throw new Error(`${this.getKind()} config does not exist: ${this.getConfigPath()}`);
        }

        configCache.set(this, config);

        return config;
    }

    async getCachedConfig () {
        const cachedConfig = configCache.get(this);

        if (cachedConfig) {
            return cachedConfig;
        }

        return await this.getConfig(...arguments);
    }
}


module.exports = Configurable;
