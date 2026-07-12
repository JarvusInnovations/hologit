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
        return 'commit' == await git.$objectExists(commit);
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

        try {
            await git.reset(holoIndexEnv, 'HEAD');
        } catch (err) {
            // re-clone index and retry once
            await fs.copyFile(indexPath, holoIndexPath);
            await git.reset(holoIndexEnv, 'HEAD');
        }

        await git.add(holoIndexEnv, { all: true });
        const treeHash = await git.writeTree(holoIndexEnv);
        logger.info(`using working tree: ${treeHash}`);
        return treeHash;
    }

    async watch ({ callback }) {
        const { default: debounce } = await import('debounce');
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
            logger.debug('watchman capabilities: %o', capabilities);


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
            logger.debug('watch established: %o', watchResponse);


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
            const { default: chokidar } = await import('chokidar');

            // Watch each ref's *parent directory* rather than the ref file:
            // git updates refs by renaming a lock file over them, which
            // orphans a file-level inotify watch — later updates then fire
            // no event at all (observed: rapid successive commits silently
            // dropped). A directory's inode survives every child rename, so
            // a directory-level watch (depth 0, filtered by path below)
            // never goes dead. Event coalescing is harmless: the handler
            // reads the ref's current value at processing time.
            const watcher = chokidar.watch([], {
                persistent: true,
                cwd: this.gitDir,
                ignoreInitial: true,
                depth: 0,
                // rename-over is git's atomic write; chokidar's own atomic
                // stabilization window would only add ~100ms of latency to
                // every ref event
                atomic: false
            });

            // Inode-based events remain the low-latency path, but they can
            // still coalesce a rapid burst into one event delivered *before*
            // the burst's final state (observed with back-to-back commits) —
            // which would leave the newest state unpublished, the one
            // failure watch may never have (specs/behaviors/watch.md). Each
            // watched ref therefore also gets a stat-polling safety net
            // (fs.watchFile): worst case it detects a dropped update one
            // interval late, and the handler's hash dedupe makes the overlap
            // harmless.
            const WATCHFILE_INTERVAL = 500;
            const nodeFs = require('fs');
            const statWatchedPaths = new Set();

            const symbolicRefs = new Map();
            const watchedRefs = new Set();
            const addRef = async ref => {
                // add watch for ref via its parent directory
                if (!watchedRefs.has(ref)) {
                    watchedRefs.add(ref);
                    watcher.add(path.dirname(ref)); // '.' for HEAD

                    const absPath = path.join(this.gitDir, ref);
                    if (!statWatchedPaths.has(absPath)) {
                        statWatchedPaths.add(absPath);
                        nodeFs.watchFile(absPath, { interval: WATCHFILE_INTERVAL }, () => {
                            enqueueRef(ref);
                        });
                    }
                }

                // resolve any symbolic target (a missing ref file — unborn
                // branch or packed ref — is simply not symbolic)
                let targetRef;
                let refContents = null;
                try {
                    refContents = await fs.readFile(path.join(this.gitDir, ref), 'ascii');
                } catch (err) {
                    if (err.code != 'ENOENT') {
                        throw err;
                    }
                }
                if (refContents && refContents.startsWith('ref:')) {
                    targetRef = refContents.substr(4).trim();
                }

                // drop tracking of any previous symbolic target
                const oldTargetRef = symbolicRefs.get(ref);
                if (oldTargetRef && oldTargetRef != targetRef) {
                    watchedRefs.delete(oldTargetRef);
                    symbolicRefs.delete(ref);
                }

                // recurse to watch target ref
                if (targetRef && targetRef != oldTargetRef) {
                    symbolicRefs.set(ref, targetRef);
                    return addRef(targetRef);
                }
            };

            // monitor for tree hash changes; ref checks are processed
            // strictly in order so concurrent handlers can't race the
            // dedupe state, and re-checks of an unchanged ref are no-ops
            let lastRefHash, lastTreeHash;
            let processing = Promise.resolve();
            const enqueueRef = ref => {
                processing = processing.then(async () => {
                    await addRef(ref); // update watch if contents is symbolic ref

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
                }).catch(err => logger.error('watch event handling failed for %s: %s', ref, err.message));
            };

            // make initial call to addRef
            await addRef(this.ref);

            watcher.on('all', (event, changedPath) => {
                if (event != 'add' && event != 'change') {
                    return;
                }
                if (!watchedRefs.has(changedPath)) {
                    return; // directory noise (e.g. gitDir root for HEAD)
                }

                enqueueRef(changedPath);
            });

            // return cancel method and watching promise
            let cancel = () => {};
            return {
                watching: new Promise((resolve, reject) => {
                    watcher.on('error', reject);
                    cancel = () => {
                        logger.debug('cancelling watcher');
                        watcher.close();
                        for (const absPath of statWatchedPaths) {
                            nodeFs.unwatchFile(absPath);
                        }
                        resolve();
                    };
                }),
                cancel
            };
        }
    }
}


module.exports = Repo;
