class Source {

    constructor (repo, name, properties = {}) {
        this.repo = repo;
        this.name = name;

        if (name == this.repo.config.holo.name) {
            this.local = true;
        }

        Object.assign(this, properties);
    }

    async init () {
        const logger = require('./logger.js');
        const hololib = require('.');
        const fs = require('mz/fs');


        // get git working tree
        const workTree = await this.repo.git.constructor.getWorkTreeFromEnvironment();
        if (!workTree) {
            throw new Error('must run with a git working tree');
        }


        // initialize repository
        const repoPath = `${workTree}/.holo/sources/${this.name}`;
        logger.info(`initializing ${repoPath}`);
        await this.repo.git.init(repoPath);


        // use main repo's objects database as alternate
        const alternatesConfigPath = `${repoPath}/.git/objects/info/alternates`;
        logger.info(`configuring ${alternatesConfigPath}`);
        await fs.writeFile(alternatesConfigPath, '../../../../../.git/objects');


        // save git instance
        this.git = new this.repo.git.Git({ workTree: repoPath, gitDir: `${repoPath}/.git` });


        // return path of initialized repository
        return repoPath;
    }

    async loadConfig (configPath = `.holo/sources/${this.name}.toml`) {
        const TOML = require('@iarna/toml');

        if (this.local) {
            // TODO: generate local configuration
            this.config = {};
            return;
        }

        try {
            this.config = TOML.parse(await this.repo.git.catFile({ p: true }, `HEAD:${configPath}`));
        } catch (err) {
            throw new Error(`source ${this.name} is not defined`);
        }

        if (!this.config) {
            throw new Error(`failed to parse ${configPath}`);
        }

        if (
            !this.config.holosource
            || !this.config.holosource.url
            || !this.config.holosource.ref
        ) {
            throw new Error(`holosource config in ${configPath} is invalid`);
        }
    }

    async loadHead () {
        try {
            this.head = await this.repo.git.revParse(this.local ? 'HEAD' : `HEAD:.holo/sources/${this.name}`);
        } catch (err) {
            this.head = null;
            return false;
        }

        return true;
    }

    async loadGit () {
        const fs = require('mz/fs');

        if (this.local) {
            this.git = this.repo.git;
        } else {
            const workTree = `${this.repo.workTree}/.holo/sources/${this.name}`;

            if (await fs.exists(workTree)) {
                const gitDir = `${workTree}/.git`;

                if (await fs.exists(gitDir)) {
                    this.git = new this.repo.git.Git({ gitDir, workTree });
                }
            }
        }
    }

    getBranch () {
        const branchMatch = this.config.holosource.ref.match(/^refs\/heads\/(\S+)$/);

        return branchMatch ? branchMatch[1] : null;
    }
}

module.exports = Source;
