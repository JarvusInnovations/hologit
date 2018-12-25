const path = require('path');
const fs = require('mz/fs');

const BlobObject = require('./BlobObject.js');
const TreeObject = require('./TreeObject.js'),
    { treeLineRe } = TreeObject;
const BlobFile = require('./BlobFile.js');
const WorkFile = require('./WorkFile.js');
const Configurable = require('./Configurable.js');
const Git = require('./Git.js');
const Branch = require('./Branch.js');
const Source = require('./Source.js');


const instanceCache = new Map();
const gitCache = new WeakMap();
const branchCache = new WeakMap();
const sourceCache = new WeakMap();


class Repo extends Configurable {

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
        super(...arguments);

        this.gitDir = gitDir;
        this.ref = ref;
        this.workTree = workTree;

        Object.freeze(this);
    }

    getKind () {
        return 'holo';
    }

    getConfigPath () {
        return '.holo/config.toml';
    }

    getRepo () {
        return this;
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

    getBranch (name) {
        let cache = branchCache.get(this);
        const cachedBranch = cache && cache.get(name);

        if (cachedBranch) {
            return cachedBranch;
        }


        // instantiate branch
        const branch = new Branch({
            repo: this,
            name
        });


        // save instance to cache
        if (!cache) {
            cache = new Map();
            branchCache.set(this, cache);
        }

        cache.set(name, branch);


        // return instance
        return branch;
    }

    getSource (name) {
        let cache = sourceCache.get(this);
        const cachedSource = cache && cache.get(name);

        if (cachedSource) {
            return cachedSource;
        }


        // instantiate branch
        const source = new Source({
            repo: this,
            name
        });


        // save instance to cache
        if (!cache) {
            cache = new Map();
            sourceCache.set(this, cache);
        }

        cache.set(name, source);


        // return instance
        return source;
    }

    async getSources () {
        const treePath = `.holo/sources`;
        const mappings = new Map();

        let tree;
        try {
            tree = await this.listTree(treePath);
        } catch (err) {
            return mappings;
        }

        for (const path of tree) {
            const pathMatches = path.match(/^([^\/]+)\.toml$/);

            // skip any file not ending in .toml
            if (!pathMatches) {
                continue;
            }

            const [,name] = pathMatches;

            mappings.set(name, this.getSource(name));
        }

        return mappings;
    }

    async resolveRef (ref = null) {
        const git = await this.getGit();
        return await git.revParse({ verify: true }, ref || this.ref, { $nullOnError: true });
    }

    async readFile (filePath) {
        if (this.workTree) {
            return fs.readFile(path.join(this.workTree, filePath), 'utf8');
        }

        const git = await this.getGit();

        return git.catFile({ p: true }, `${this.ref}:${filePath}`);
    }

    async listTree (treePath) {

        // read work tree from disk
        if (this.workTree) {
            const treeFsPath = path.join(this.workTree, treePath);
            const childNames = await fs.readdir(treeFsPath);
            const children = await Promise.all(childNames.map(async childName => {
                const childFsPath = path.join(treeFsPath, childName);
                const childStat = await fs.stat(childFsPath);

                if (childStat.isDirectory()) {
                    const grandChildren = await this.listTree(path.join(treePath, childName));
                    return grandChildren.map(grandChildName => path.join(childName, grandChildName));
                } else {
                    return [childName];
                }
            }));

            return [].concat(...children);
        }

        // read ref from git
        const git = await this.getGit();
        let treeOutput;

        try {
            treeOutput = (await git.lsTree({ 'full-tree': true, r: true, 'name-only': true }, `${this.ref}:${treePath}`)).split('\n');
        } catch (err) {
            treeOutput = [];
        }

        return treeOutput;
    }

    async readTree (treePath) {

        // read work tree from disk
        if (this.workTree) {
            const treeFsPath = path.join(this.workTree, treePath);
            const childNames = await fs.readdir(treeFsPath);
            const children = await Promise.all(childNames.map(async childName => {
                const childFsPath = path.join(treeFsPath, childName);
                const childStat = await fs.stat(childFsPath);
                const children = {};

                if (childStat.isDirectory()) {
                    const grandChildren = await this.readTree(path.join(treePath, childName));
                    for (const grandChildName in grandChildren) {
                        children[path.join(childName, grandChildName)] = grandChildren[grandChildName];
                    }
                } else {
                    children[childName] = new WorkFile(childFsPath);
                }

                return children;
            }));

            return Object.assign(...children);
        }

        // read ref from git
        const git = await this.getGit();
        let treeOutput;

        try {
            treeOutput = (await git.lsTree({ 'full-tree': true, r: true }, `${this.ref}:${treePath}`)).split('\n');
        } catch (err) {
            treeOutput = [];
        }

        const tree = {};
        for (const treeLine of treeOutput) {
            const [, mode,, hash, path] = treeLineRe.exec(treeLine);

            tree[path] = new BlobFile({
                repo: this,
                hash,
                mode
            });
        }

        return tree;
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

    createBlob () {
        return new BlobObject(this, ...arguments);
    }

    createTree () {
        return new TreeObject(this, ...arguments);
    }

    async createTreeFromRef () {
        return TreeObject.createFromRef(this, ...arguments);
    }
}


module.exports = Repo;
