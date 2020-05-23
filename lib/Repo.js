const path = require('path');
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
        const repo = new this({
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

    constructor ({ gitDir, ref = 'HEAD', workTree = null }) {
        this.gitDir = gitDir;
        this.ref = ref;
        this.workTree = workTree;

        Object.freeze(this);
    }

    async getWorkspace () {
        let workspace = workspaces.get(this);

        if (!workspace) {
            workspace = this.workTree
                ? await this.createWorkspaceFromTreeHash(await this.hashWorkTree())
                : await this.createWorkspaceFromRef(this.ref);
            workspaces.set(this, workspace);
        }

        return workspace;
    }

    async createWorkspaceFromRef (ref) {
        return new Workspace({ root: await this.createTreeFromRef(ref) });
    }

    async createWorkspaceFromTreeHash (hash) {
        return new Workspace({ root: await this.createTree({ hash }) });
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

    async writeBlobFromFile () {
        return BlobObject.writeFromFile(this, ...arguments);
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

    /**
     * Test whether a given commit is available in the repository
     * @param {string} commit-  hash or ref for commit to check
     */
    async hasCommit (commit) {
        const git = await this.getGit();
        return 'commit' == await git.catFile({ t: true }, commit, { $nullOnError: true });
    }

    async hashWorkTree () {
        const logger = require('../lib/logger.js');

        if (!this.workTree) {
            throw new Error('cannot call hashWorkTree from non-working repo instance');
        }
        const git = await this.getGit();


        // get holoindex path, cloning index if needed
        const indexPath = await git.getIndexPath();
        const holoIndexPath = `${indexPath}.holo`;
        if (!await fs.exists(holoIndexPath) && await fs.exists(indexPath)) {
            await fs.copyFile(indexPath, holoIndexPath);
        }


        // build a tree via the cloned index
        logger.info('indexing working tree (this can take a while under Docker)...');
        const holoIndexEnv = { $indexFile: holoIndexPath };
        await git.reset(holoIndexEnv, 'HEAD');
        await git.add(holoIndexEnv, { all: true });
        const treeHash = await git.writeTree(holoIndexEnv);
        logger.info(`using working tree: ${treeHash}`);
        return treeHash;
    }

    async watch ({ callback }) {
        const debounce = require('debounce');
        const logger = require('../lib/logger.js');


        // either use watchman to monitor working tree or use fs.watch on .git/HEAD
        if (this.workTree) {
            // load watchman client
            const watchman = require('fb-watchman');
            const client = new watchman.Client();


            // get watchman capabilities
            const capabilities = await new Promise((resolve, reject) => {
                client.capabilityCheck(
                    {
                        required: ['relative_root', 'term-dirname', 'term-not', 'term-allof', 'term-type'],
                        optional: ['defer_vcs']
                    },
                    (err, response) => {
                        if (err) {
                            client.end();
                            reject(err);
                        } else {
                            resolve(response);
                        }
                    }
                );
            });
            logger.debug('watchman capabilities:', capabilities);


            // initiate watch
            const watchResponse = await new Promise((resolve, reject) => {
                client.command(['watch-project', this.workTree], (err, response) => {
                    if (err) {
                        client.end();
                        reject(err);
                    } else {
                        if ('warning' in response) {
                            logger.warn(response.warning);
                        }
                        resolve(response);
                    }
                });
            });
            logger.debug('watch established:', watchResponse);


            // get current clock
            const clockResponse = await new Promise((resolve, reject) => {
                client.command(['clock', watchResponse.watch], (err, response) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(response);
                    }
                });
            });


            // subscribe to changes
            const subscription = await new Promise((resolve, reject) => {
                const expression = [
                    'allof',
                    ['type', 'f'],
                    ['not', ['suffix', 'swp']],
                    ['not', ['suffix', 'swo']],
                    ['not', ['match', '*~', 'basename', { includedotfiles: true }]],
                    ['not', ['match', '.watchman-*', 'basename', { includedotfiles: true }]]

                ];

                const gitDirRelative = path.relative(this.workTree, this.gitDir);
                if (!gitDirRelative.startsWith('../')) {
                    expression.push(['not', ['dirname', gitDirRelative]]);
                }

                client.command(
                    [
                        'subscribe',
                        watchResponse.watch,
                        'hologitsubscription',
                        {
                            expression: expression,
                            since: clockResponse.clock,
                            relative_root: watchResponse.relative_path,
                            defer_vcs: true
                        }
                    ],
                    (err, response) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(response);
                        }
                    }
                );
            });


            // relay changes to tree
            // TODO: why is this extra dupe suppression necessary? watchman should handle this
            client.on('subscription', debounce(async () => {
                callback(await this.hashWorkTree());
            }, 50));


            // return cancel method and watching promise
            let cancel = () => {};
            return {
                watching: new Promise((resolve, reject) => {
                    cancel = resolve;
                    client.on('end', resolve);
                }),
                cancel
            };
        } else {
            const chokidar = require('chokidar');
            const watcher = chokidar.watch([], {
                persistent: true,
                cwd: this.gitDir,
                ignoreInitial: true
            });

            // watcher.on('all', logger.debug);
            // watcher.on('error', logger.error);

            const symbolicRefs = new Map();
            const addRef = async ref => {
                // add watch for ref
                watcher.add(ref);

                // debug output watcher.add result
                // setTimeout(() => {
                //     const watched = watcher.getWatched();
                //     logger.debug('watcher.add(%s)', ref, [].concat(...Object.keys(watched).map(watchedDir => watched[watchedDir].map(watchedFile => path.join(watchedDir, watchedFile)))));
                // }, 100);

                // resolve any symbolic target
                let targetRef;
                const refContents = await fs.readFile(path.join(this.gitDir, ref), 'ascii');
                if (refContents.startsWith('ref:')) {
                    targetRef = refContents.substr(4).trim();
                }

                // remove existing watch on any symbolic target
                const oldTargetRef = symbolicRefs.get(ref);
                if (oldTargetRef && oldTargetRef != targetRef) {
                    watcher.unwatch(oldTargetRef);
                    symbolicRefs.delete(ref);
                }

                // recurse to watch target ref
                if (targetRef && targetRef != oldTargetRef) {
                    symbolicRefs.set(ref, targetRef);
                    return addRef(targetRef);
                }
            };

            // make initial call to addRef
            await addRef(this.ref);

            // monitor for tree hash changes
            let lastRefHash, lastTreeHash;
            watcher.on('change', async ref => {
                await addRef(ref); // add watch if contents is symbolic ref

                const git = await this.getGit();
                const refHash = await git.revParse({ verify: true }, ref);

                if (refHash != lastRefHash) {
                    lastRefHash = refHash;
                    const treeHash = await git.getTreeHash(refHash);
                    if (treeHash != lastTreeHash) {
                        lastTreeHash = treeHash;
                        callback(treeHash, refHash);
                    }
                }
            });

            // return cancel method and watching promise
            let cancel = () => {};
            return {
                watching: new Promise((resolve, reject) => {
                    watcher.on('error', reject);
                    cancel = () => {
                        logger.debug('cancelling watcher');
                        watcher.close();
                        resolve();
                    };
                }),
                cancel
            };
        }
    }
}


module.exports = Repo;
