const TOML = require('@iarna/toml');
const path = require('path');
const fs = require('mz/fs');

const Git = require('./Git');


const instanceCache = new Map();
const gitCache = new WeakMap();


class Repo {

    /**
     * Get holo repo instance from environment
     */
    static async getFromEnvironment ({ ref = 'HEAD', working = false } = {}) {
        const git = await Git.get();


        // get git repository
        const gitDir = await git.constructor.getGitDirFromEnvironment();

        if (!gitDir) {
            throw new Error('current directory is not a git repository and none was otherwise specified');
        }


        // attempt to resolve ref
        const refHash = await git.revParse({ verify: true }, ref);

        if (!refHash) {
            throw new Error(`ref ${ref} could not be resolved`);
        }


        // get git working tree
        const workTree = working && await git.constructor.getWorkTreeFromEnvironment();

        if (working && !workTree) {
            throw new Error('current directory is not a work tree and none was otherwise specified');
        }


        // try to return existing instance first
        let cache = instanceCache.get(gitDir);
        const cacheKey = working ? `working:${workTree}` : `ref:${ref}`;
        const cachedRepo = cache && cache.get(cacheKey);

        if (cachedRepo) {
            return cachedRepo;
        }


        // instantiate repo
        const repo = new Repo({
            gitDir,
            ref,
            workTree
        });


        // save instance to cache
        if (!cache) {
            cache = new Map();
            instanceCache.set(gitDir, cache);
        }

        cache.set(cacheKey, repo);


        // return instance
        return repo;
    }

    constructor ({ gitDir, ref, workTree = null }) {
        this.gitDir = gitDir;
        this.ref = ref;
        this.workTree = workTree;

        Object.freeze(this);
    }

    async getGit () {
        const cachedGit = gitCache.get(this);
        if (cachedGit) {
            return cachedGit;
        }

        const envGit = await Git.get();

        const git = new envGit.Git({
            gitDir: this.gitDir,
            workTree: this.workTree
        });

        gitCache.set(this, git);

        return git;
    }

    async readFile (filePath) {
        if (this.workTree) {
            return fs.readFile(path.join(this.workTree, filePath), 'utf8');
        }

        const git = await this.getGit();

        return git.catFile({ p: true }, `${this.ref}:${filePath}`);
    }

    async writeFile (filePath, contents, { stage = true, commitMessage = null } = {}) {
        if (this.workTree) {
            const workFilePath = path.join(this.workTree, filePath);

            // ensure containing directory exists
            const workFileDir = path.dirname(workFilePath);
            if (!await fs.exists(workFileDir)) {
                await require('mz-modules/mkdirp')(workFileDir);
            }

            // write contents to disk
            await fs.writeFile(workFilePath, contents, 'utf8');

            // stage if enabled
            if (stage) {
                const git = await this.getGit();
                await git.add(workFilePath);
            }
        } else {
            // TODO: move TreeObject into hologit/lib
            // TODO: load tree object from ref
            // TODO: merge new file into tree
            // TODO: write commit to ref: holo: write ${filePath}
            if (!commitMessage) {
                commitMessage = `holo: write ${filePath}`;
            }
            debugger;
        }
    }

    async readConfig () {
        const tomlPath = `.holo/config.toml`;

        let toml;
        try {
            toml = await this.readFile(tomlPath);
        } catch (err) {
            return null;
        }

        let config;
        try {
            config = TOML.parse(toml);
        } catch (err) {
            throw new Error(`could not parse ${tomlPath}: ${err.message}`);
        }

        if (!config.holo) {
            throw new Error(`holo config not found in ${tomlPath}`);
        }

        return config.holo;
    }

    async writeConfig (repoConfig, writeOptions = {}) {
        const tomlPath = `.holo/config.toml`;

        let toml;
        try {
            toml = await this.readFile(tomlPath);
        } catch (err) {
            toml = null;
    }

        const config = toml && TOML.parse(toml) || {};

        config.holo = repoConfig;

        return this.writeFile(tomlPath, TOML.stringify(config), writeOptions);
    }

    async getConfig () {
        const repoConfig = await this.readConfig();

        if (!repoConfig) {
            throw new Error('repo config does not exist, initialize with \`git holo init\`');
        }

        return repoConfig;
    }

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
