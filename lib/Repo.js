class Repo {

    constructor (git, properties = {}) {
        this.git = git;
        this.sources = {};

        Object.assign(this, properties);
    }

    async getSource (name) {
        const logger = require('./logger.js');
        const hololib = require('./');
        const fs = require('mz/fs');
        const path = require('path');

        // try to return existing instance
        if (this.sources[name]) {
            return this.sources[name];
        }

        // instantiate source
        const source = new hololib.Source(this, name);

        // load config
        await source.loadConfig();

        // load HEAD
        await source.loadHead();

        // load git interface
        await source.loadGit();

        // ensure source objects are in main repository's alternates
        if (source.git && !source.local) {
            const alternatesConfigPath = `${this.gitDir}/objects/info/alternates`;
            let alternatesConfig;

            try {
                alternatesConfig = await fs.readFile(alternatesConfigPath, 'ascii');
                alternatesConfig = alternatesConfig.trim().split('\n');
            } catch (err) {
                if (err.code != 'ENOENT') {
                    throw err;
                }

                alternatesConfig = [];
            }

            const relativeObjectsPath = path.relative(`${this.gitDir}/objects`, `${source.git.gitDir}/objects`);

            if (alternatesConfig.indexOf(relativeObjectsPath) == -1) {
                logger.info(`adding ${relativeObjectsPath} to ${alternatesConfigPath}`);

                alternatesConfig.push(relativeObjectsPath);
                await fs.writeFile(alternatesConfigPath, alternatesConfig.join('\n'));
            }
        }

        // return info structure
        return source;
    }
}

module.exports = Repo;
