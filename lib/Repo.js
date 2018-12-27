const fs = require('mz/fs');

const BlobObject = require('./BlobObject.js');
const TreeObject = require('./TreeObject.js');
const CommitObject = require('./CommitObject.js');
const Git = require('./Git.js');
const Workspace = require('./Workspace.js');


const instanceCache = new Map();
const gitCache = new WeakMap();
const workspaces = new WeakMap();


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


        // ensure .git/holo/ directory exists
        if (!await fs.exists(`${gitDir}/holo`)) {
            await fs.mkdir(`${gitDir}/holo`);
        }


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

    async getWorkspace () {
        let workspace = workspaces.get(this);

        if (!workspace) {
            let root;

            if (this.workTree) {
                const git = await this.getGit();

                // clone the index
                const indexPath = await git.getIndexPath();
                const holoIndexPath = `${indexPath}.holo`;
                await fs.copyFile(indexPath, holoIndexPath);

                // create a reusable set of options for operating on the cloned index
                const holoIndexEnv = {
                    $indexFile: holoIndexPath
                };

                // build a tree via the cloned index
                await git.add(holoIndexEnv, { all: true });
                root = await this.createTreeFromRef(await git.writeTree(holoIndexEnv));
            } else {
                root = await this.createTreeFromRef(this.ref);
            }

            workspace = new Workspace({ root });
            workspaces.set(this, workspace);
        }

        return workspace;
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

    async resolveRef (ref = null) {
        const git = await this.getGit();
        return await git.revParse({ verify: true }, ref || this.ref, { $nullOnError: true });
    }

    createBlob () {
        return new BlobObject(this, ...arguments);
    }

    async writeBlob () {
        return BlobObject.write(this, ...arguments);
    }

    createTree () {
        return new TreeObject(this, ...arguments);
    }

    async createTreeFromRef () {
        return TreeObject.createFromRef(this, ...arguments);
    }

    createCommit () {
        return new CommitObject(this, ...arguments);
    }
}


module.exports = Repo;
