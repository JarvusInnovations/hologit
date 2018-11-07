const fs = require('mz/fs');
const logger = require('./logger.js');
const mkdirp = require('mz-modules/mkdirp');
const path = require('path');
const TOML = require('@iarna/toml');


class Source {

    constructor (repo, name, properties = {}) {
        this.repo = repo;
        this.name = name;

        if (name == this.repo.config.holo.name) {
            this.local = true;
        }

        Object.assign(this, properties); // TODO: no, accept only config
    }

    getLocalRef () {
        return `refs/holo/sources/${this.name}/${this.config.holosource.ref.substr(5)}`;
    }

    async init () {
        // get git working tree
        const repoWorkTree = await this.repo.git.constructor.getWorkTreeFromEnvironment();
        if (!repoWorkTree) {
            throw new Error('must run with a git working tree');
        }


        // initialize repository
        const sourcePath = `.holo/sources/${this.name}`;
        const workTree = `${repoWorkTree}/${sourcePath}`;
        const gitDir = `${this.repo.gitDir}/modules/${sourcePath}`;

        logger.info(`initializing ${workTree}`);
        await mkdirp(gitDir);
        await this.repo.git.init({ 'separate-git-dir': gitDir }, workTree);


        // use main repo's objects database as alternate
        const alternatesConfigPath = `${gitDir}/objects/info/alternates`;
        logger.info(`configuring ${alternatesConfigPath}`);
        await fs.writeFile(alternatesConfigPath, path.relative(`${gitDir}/objects`, `${this.repo.gitDir}/objects`));


        // save git instance
        this.git = new this.repo.git.Git({ workTree, gitDir });
    }

    async fetch () {
        const { url, ref } = this.config.holosource;
        const localRef = this.getLocalRef();


        // fetch current head first
        if (this.head) {
            logger.info(`fetching head ${ref}@${this.head}`);
            await this.repo.git.fetch({ depth: 1 }, url, `+${this.head}:${localRef}`);
        }


        // examine remote repo/branch
        logger.info(`listing ${url}#${ref}`);
        const lsRemoteOutput = await this.repo.git.lsRemote(url, ref);
        const match = lsRemoteOutput.match(/^([0-9a-f]{40})\t(\S+)$/m);

        if (!match) {
            throw new Error(`could not find remote ref for ${ref}`);
        }

        const hash = match[1];


        // fetch remote head
        if (hash != this.head) {
            logger.info(`fetching remote ${ref}@${hash}`);
            await this.repo.git.fetch({ depth: 1 }, url, `+${hash}:${localRef}`);
        }

        return hash;
    }

    async loadConfig (configPath = `.holo/sources/${this.name}.toml`) {
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
        if (this.local) {
            this.head = await this.repo.git.revParse({ verify: true }, 'HEAD');
        } else {
            try {
                this.head = await this.repo.git.revParse({ verify: true }, `HEAD:.holo/sources/${this.name}`);
            } catch (err) {
                this.head = await this.fetch();
            }
        }

        return true;
    }

    async loadGit () {

        if (this.local) {
            this.git = this.repo.git;
        } else {
            const workTree = `${this.repo.workTree}/.holo/sources/${this.name}`;

            if (await fs.exists(workTree)) {
                let gitDir = `${workTree}/.git`;

                try {
                    const gitDirStat = await fs.stat(gitDir);

                    // if .git is a file, read gitdir from it
                    if (gitDirStat.isFile()) {
                        const gitFileContent = await fs.readFile(gitDir, 'ascii');
                        const gitFileMatch = gitFileContent.match(/^gitdir: (\S+)/);

                        if (!gitFileMatch) {
                            throw new Error(`could not parse gitdir from file: ${gitDir}`);
                        }

                        gitDir = path.join(gitDir, '..', gitFileMatch[1]);
                    }

                    this.git = new this.repo.git.Git({ gitDir, workTree });
                } catch (err) {
                    if (err.code != 'ENOENT') {
                        throw err;
                    }

                    // it's ok for git dir to not exist, just don't set this.git
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
