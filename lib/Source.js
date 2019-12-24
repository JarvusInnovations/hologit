const path = require('path');
const fs = require('mz/fs');
const parseUrl = require('parse-url');


const logger = require('./logger');
const Git = require('./Git.js');
const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');
const Projection = require('./Projection.js');


const specCache = new WeakMap();
const headCache = new WeakMap();


class Source extends Configurable {

    constructor ({ workspace, name }) {
        super(...arguments);

        this.name = name;

        const [holosourceName, holobranchName] = name.split('=>', 2);

        this.holosourceName = holosourceName;
        this.holobranchName = holobranchName || null;

        Object.freeze(this);
    }

    getKind () {
        return 'holosource';
    }

    getConfigPath () {
        return `.holo/sources/${this.holosourceName}.toml`;
    }

    async readConfig () {
        let config;

        const { name: workspaceName } = await this.workspace.getCachedConfig();
        if (this.holosourceName == workspaceName) {
            config = {
                $workspace: true
            };
        } else {
            const defaultConfig = await super.readConfig();

            // overwrite from environment
            const envName = `HOLO_SOURCE_${this.name.replace(/-/g, '_').toUpperCase()}`;
            const envValue = process.env[envName];

            if (envValue) {
                const envMatch = envValue.match(/^(?<url>[^#=]+)?(#(?<ref>[^=]+)(=>(?<holobranch>.*))?)?$/);

                if (!envMatch) {
                    throw new Error(`unable to parse ${envName} value: ${envValue}`);
                }

                const { url, ref, holobranch } = envMatch.groups;

                config = Object.create(defaultConfig);

                if (url) {
                    config.url = url;
                }

                if (ref) {
                    config.ref = ref;
                    config.project = holobranch ? { holobranch } : null;
                }
            } else {
                config = defaultConfig;
            }
        }

        return config;
    }

    async getConfig () {
        const config = await super.getConfig();

        if (!config.$workspace && !config.ref && config.url) {
            throw new Error(`holosource has no ref defined: ${this.name}`);
        }

        return config;
    }

    async getSpec () {
        const { url } = await this.getCachedConfig();
        const data = {};

        if (url) {
            const { resource: host, pathname: path } = parseUrl(url);
            data.host = host.toLowerCase();
            data.path = path.toLowerCase().replace(/\/?\.git$/, '');
        } else {
            data.path = '.';
        }

        const spec = {
            ...await SpecObject.write(this.workspace.root.repo, 'source', data),
            data
        };

        specCache.set(this, spec);

        return spec;
    }

    async getCachedSpec () {
        const cachedSpec = specCache.get(this);

        if (cachedSpec) {
            return cachedSpec;
        }

        return await this.getSpec(...arguments);
    }

    async queryRef () {
        const { url, ref } = await this.getCachedConfig();
        const git = await this.getRepo().getGit();
        const lsRemoteOutput = await git.lsRemote({ symref: true }, url, ref);
        const match = lsRemoteOutput.match(/^(ref: (refs\/heads\/\S+)\tHEAD\n)?([0-9a-f]{40})\t(\S+)$/m);

        if (!match) {
            return null;
        }

        return {
            hash: match[3],
            ref: match[2] || match[4]
        };
    }

    async hashWorkTree () {
        const repo = this.getRepo();
        if (!repo.workTree) {
            throw new Error('cannot call hashWorkTree from non-working repo instance');
        }


        const subGit = await this.getSubGit();
        if (!subGit || !subGit.workTree) {
            return null;
        }


        // get holoindex path, cloning index if needed
        const indexPath = await subGit.getIndexPath();
        const holoIndexPath = `${indexPath}.holo`;
        if (!await fs.exists(holoIndexPath) && await fs.exists(indexPath)) {
            await fs.copyFile(indexPath, holoIndexPath);
        }


        // build a tree via the cloned index
        logger.info(`indexing ${this.name} working tree (this can take a while under Docker)...`);
        const holoIndexEnv = { $indexFile: holoIndexPath };
        await subGit.reset(holoIndexEnv, 'HEAD');
        await subGit.add(holoIndexEnv, { all: true });
        const treeHash = await subGit.writeTree(holoIndexEnv);
        logger.info(`using ${this.name} working tree: ${treeHash}`);
        return treeHash;
    }

    async getOutputTree ({ working = null, fetch = false, cacheFrom = null, cacheTo = null } = {}) {
        const repo = this.getRepo();
        const git = await repo.getGit();
        const { project } = await this.getCachedConfig();

        let head = await this.getHead({ working });

        // apply source projection
        if (project) {
            if (!project.holobranch) {
                throw new Error('holosource.project config must include holobranch');
            }

            logger.info(`projecting holobranch ${project.holobranch} within source ${this.name}@${head.substr(0, 8)}`);
            const workspace = await repo.createWorkspaceFromRef(head);
            const branch = workspace.getBranch(project.holobranch);

            let { lens } = await branch.getCachedConfig();
            if (typeof lens != 'boolean') {
                if (typeof project.lens == 'boolean') {
                    lens = project.lens
                } else {
                    lens = true;
                }
            }

            head = await Projection.projectBranch(branch, {
                debug: true,
                lens,
                fetch,
                cacheFrom,
                cacheTo
            });

            logger.info(`using projection result for holobranch ${project.holobranch} as source ${this.name}: ${head}`);
        } else {
            head = await git.getTreeHash(head);
        }

        // apply mapping projection
        if (this.holobranchName) {
            logger.info(`projecting holobranch ${this.holobranchName} within source ${this.holosourceName}@${head.substr(0, 8)}`);
            const workspace = await repo.createWorkspaceFromRef(head);
            const branch = workspace.getBranch(this.holobranchName);

            let { lens } = await branch.getCachedConfig();
            if (typeof lens != 'boolean') {
                lens = true;
            }

            head = await Projection.projectBranch(branch, {
                debug: true,
                lens,
                fetch
            });

            logger.info(`using projection result for holobranch ${this.holobranchName} as source ${this.name}: ${head}`);
        }

        return head;
    }

    async getHead ({ required=false, working=null } = {}) {
        const repo = this.getRepo();
        const git = await repo.getGit();
        const { $workspace, url, ref } = await this.getCachedConfig();


        // special value indicates that the containing in-flight workspace is the source
        if ($workspace) {
            return await this.workspace.root.write();
        }


        // get value of gitlink if it exists
        const sourcePath = `.holo/sources/${this.name}`;
        const gitLink = await this.workspace.root.getChild(sourcePath);
        const gitLinkHash = gitLink && gitLink.isCommit && gitLink.hash;


        // fall few a few different ways to determine the current commit hash to use
        let head;


        // hash source sub-worktree if available
        // TODO: ask the workspace if it's got a worktree or something, delegate much of this to the workspace so it can be virtual
        if (repo.workTree && working !== false) {
            const workTreeHash = await this.hashWorkTree();
            if (workTreeHash) {
                let workTreeCommit;

                // check if staged gitlink matches working tree
                const [,stagedHash] = (await git.lsFiles({ stage: true }, sourcePath)).split(/\s/, 4);
                if (
                    stagedHash
                    && await git.getTreeHash(stagedHash) == workTreeHash
                ) {
                    workTreeCommit = stagedHash;
                }

                // else, check if committed gitlink matches working tree
                if (
                    !workTreeCommit
                    && gitLinkHash
                    && await git.getTreeHash(gitLinkHash) == workTreeHash
                ) {
                    workTreeCommit = gitLinkHash;
                }

                // else, create a commit
                if (workTreeCommit) {
                    head = workTreeCommit;
                } else {
                    head = await git.commitTree(
                        {
                            p: stagedHash || gitLinkHash || null,
                            m: `working snapshot of ${repo.workTree}/${sourcePath}`
                        },
                        workTreeHash
                    );
                }
            }
        }


        // try to get head from gitlink commit entry in sources tree
        if (!head && gitLinkHash) {
            head = gitLinkHash;

            // if the indicated head is not available, try a broad fetch on the source
            if (!await repo.hasCommit(gitLinkHash)) {
                const { ref: specRef } = await this.getCachedSpec();
                const headRef = `${specRef}/${ref.substr(5)}`; // TODO: should this be 0, 5?
                const resolvedRef = await repo.resolveRef(headRef);

                if (!resolvedRef) {
                    await this.fetch();
                }

                if (!await repo.hasCommit(gitLinkHash)) {
                    await this.fetch({ unshallow: true }, 'refs/heads/*');

                    if (!await repo.hasCommit(gitLinkHash)) {
                        throw new Error(`${sourcePath} is set to commit ${head}, but that commit is not exposed by any branch on the source`);
                    }
                }
            }
        }

        // try to get from local ref
        if (!head && !url) {
            head = await repo.resolveRef(ref);
        }

        // try to get head from remote specRef
        if (!head && url) {
            const { ref: specRef } = await this.getCachedSpec();
            const headRef = `${specRef}/${ref.substr(5)}`;

            head = await repo.resolveRef(headRef);

            // try to fetch head
            if (!head) {
                await this.fetch();
                head = await repo.resolveRef(headRef);
            }
        }

        // unresolved head is an exception
        if (required && !head) {
            throw new Error(`could not resolve head commit for holosource ${this.name}`);
        }

        if (!head) {
            head = null;
        }

        headCache.set(this, head);

        return head;
    }

    async getCachedHead () {
        const cachedHead = headCache.get(this);

        if (cachedHead) {
            return cachedHead;
        }

        return await this.getHead(...arguments);
    }

    async getBranch () {
        const { ref } = await this.getCachedConfig();
        const refMatch = ref.match(/^refs\/heads\/(\S+)$/);
        return refMatch ? refMatch[1] : null;
    }

    async fetch ({ depth=1, unshallow=null } = {}, ...refs) {
        const repo = this.getRepo();
        const { url, ref: configRef } = await this.getCachedConfig();

        if (!url) {
            return {
                refs: [ configRef || repo.ref || 'HEAD' ]
            };
        }

        if (!refs.length) {
            refs.push(configRef);
        }

        for (const ref of refs) {
            if (!ref.startsWith('refs/')) {
                throw new Error(`ref ${ref} must start with refs/`);
            }
        }

        if (unshallow) {
            depth = null;
        }

        const git = await repo.getGit();
        const { ref: specRef } = await this.getCachedSpec();
        await git.fetch({ depth, unshallow, tags: false }, url, ...refs.map(ref => `+${ref}:${specRef}/${ref.substr(5)}`));

        return {
            refs: refs.map(ref => `${specRef}/${ref.substr(5)}`)
        };
    }

    async getSubGit ({ required=false } = {}) {
        const repo = this.getRepo();
        const subRepoPath = `.holo/sources/${this.name}`;


        // determine workTree
        let workTree = repo.workTree && path.join(repo.workTree, subRepoPath);

        if (!workTree || !await fs.exists(workTree)) {
            workTree = null;
        }


        // determine gitDir
        const { hash: specHash } = await this.getCachedSpec();

        const gitDir = path.join(repo.gitDir, 'modules', specHash);
        if (!await fs.exists(gitDir)) {
            if (required) {
                throw new Error(`submodule ${subRepoPath} is not initialized; try running: git holo source checkout ${this.name}`);
            } else {
                return null;
            }
        }


        // build git instance
        const envGit = await Git.get();
        return new envGit.Git({ gitDir, workTree });
    }

    async checkout ({ submodule=false }) {
        const mkdirp = require('mz-modules/mkdirp');

        const repo = this.getRepo();
        const { gitDir, workTree } = repo;
        const git = await repo.getGit();
        const { url, ref } = await this.getCachedConfig();
        const branch = await this.getBranch();


        // get work tree
        if (!workTree) {
            throw new Error('no work tree found, cannot checkout sub-repository');
        }


        // initialize sub-repository work tree
        const subRepoPath = `.holo/sources/${this.name}`;
        const subWorkTree = path.join(workTree, subRepoPath);
        await mkdirp(subWorkTree);


        // initialize sub-repository
        let head;
        if (await fs.exists(`${subWorkTree}/.git`)) {
            const subGit = await this.getSubGit({ required: true });
            head = await subGit.revParse({ verify: true }, 'HEAD');
        } else {
            const { hash: specHash } = await this.getCachedSpec();
            const subRepoGitDir = path.join(gitDir, 'modules', specHash);

            // initialize bare repository in submodule-like location
            if (!await fs.exists(subRepoGitDir)) {
                const envGit = await Git.get();
                await envGit.init({ bare: true }, subRepoGitDir);
            }

            // point sub working tree at submodule-like repo outside working tree
            await fs.writeFile(`${subWorkTree}/.git`, `gitdir: ${path.relative(subWorkTree, subRepoGitDir)}\n`);

            // configure sub-repository
            const subGit = await this.getSubGit({ required: true });
            await subGit.config('core.bare', 'false');
            await subGit.config('core.worktree', path.relative(subRepoGitDir, subWorkTree));

            // share objects in both directions with superproject repo
            await subGit.addToConfigSet('objects/info/alternates', path.relative(`${subRepoGitDir}/objects`, `${gitDir}/objects`));
            await git.addToConfigSet('objects/info/alternates', path.relative(`${gitDir}/objects`, `${subRepoGitDir}/objects`));

            // stage head as gitlink
            head = await this.getHead({ working: false });
            // TODO: this fails when checking out a projected source
            // TODO: this head should never be projected, maybe stop projecting in getHead and have another get-tree method? or just call something different here?
            await git.updateIndex({ add: true, cacheinfo: true }, `160000,${head},${subRepoPath}`);

            // add remote
            await subGit.config(`remote.origin.url`, url || gitDir);

            // configure upstream
            if (branch) {
                const remoteRef = `refs/remotes/origin/${branch}`;
                await subGit.updateRef(remoteRef, head);
                await subGit.updateRef('FETCH_HEAD', head);

                await subGit.config(`branch.${branch}.remote`, 'origin');
                await subGit.config(`branch.${branch}.merge`, ref);
                await subGit.config(`branch.${branch}.rebase`, 'true');
                await subGit.config(`remote.origin.fetch`, `+${ref}:${remoteRef}`);
            } else {
                await subGit.config(`remote.origin.fetch`, `+${ref}:${ref}`);
            }

            // initialize FETCH_HEAD
            await subGit.fetch({ depth: 1, tags: false }); // TODO: shallow: true? does this make that happen?

            // check out ref
            await subGit.updateRef(ref, head);
            await subGit.symbolicRef('HEAD', ref);
            await subGit.checkout({ $cwd: subWorkTree }, '--');
        }


        // configure submodule
        if (submodule) {
            await git.config(`submodule.${subRepoPath}.active`, 'true');
            await git.config(`submodule.${subRepoPath}.url`, url || gitDir);

            const submoduleConfig = {
                path: subRepoPath,
                url: url || gitDir,
                shallow: 'true'
            };

            if (branch) {
                submoduleConfig.branch = branch;
            }


            // write submodule config
            for (const key in submoduleConfig) {
                await git.config({ file: '.gitmodules' }, `submodule.${subRepoPath}.${key}`, submoduleConfig[key]);
            }
            await git.add('.gitmodules');
        }


        return {
            path: subRepoPath,
            head,
            branch,
            url,
            ref,
            submodule
        };
    }

}

module.exports = Source;
