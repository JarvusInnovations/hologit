class Repo {

    constructor (git, properties = {}) {
        this.git = git;
        this.sources = {};

        Object.assign(this, properties);
    }

    async getSource (name) {
        const hololib = require('./');

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

        // return info structure
        return source;
    }
}

module.exports = Repo;
