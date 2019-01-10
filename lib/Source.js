const path = require('path');
const fs = require('mz/fs');
const parseUrl = require('parse-url');


const Git = require('./Git.js');
const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');


const specCache = new WeakMap();
const headCache = new WeakMap();


class Source extends Configurable {

    constructor ({ workspace, name }) {
        super(...arguments);

        this.name = name;

        Object.freeze(this);
    }

    getKind () {
        return 'holosource';
    }

    getConfigPath () {
        return `.holo/sources/${this.name}.toml`;
    }

    async readConfig () {
        const { name: workspaceName } = await this.workspace.getCachedConfig();

        if (this.name == workspaceName) {
            return {
                local: true
            };
        }

        return super.readConfig();
    }

    async getConfig () {
        const config = await super.getConfig();

        if (!config.local) {
            if (!config.url) {
                throw new Error(`holosource has no url defined: ${this.name}`);
            }

            if (!config.ref) {
                throw new Error(`holosource has no url defined: ${this.name}`);
            }
        }

        return config;
    }

    async getSpec () {
        const { url, ref } = await this.getCachedConfig();

        const { resource: host, pathname: path } = parseUrl(url);

        const data = {
            host,
            path: path.replace(/\/?\.git$/, ''),
            ref
        };

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

    async getHead ({ required=false } = {}) {
        const repo = this.getRepo();
        const { local } = await this.getCachedConfig();

        if (local) {
            return await this.workspace.root.write();
        }

        let head;

        // try to get from submodule
        if (repo.workTree) {
            const subGit = await this.getSubGit();

            if (subGit) {
                head = await subGit.revParse({ verify: true }, 'HEAD', { $nullOnError: true });
            }
        }


        // try to get head from submodule gitlink
        if (!head) {
            head = await repo.resolveRef(`${repo.ref}:.holo/sources/${this.name}`);
        }

        // try to get head from specRef
        if (!head) {
            const { ref: specRef } = await this.getCachedSpec();
            head = await repo.resolveRef(specRef);
        }

        // try to fetch head
        if (!head) {
            head = await this.fetch();
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

    async fetch () {
        const { url } = await this.getCachedConfig();
        const { ref: specRef } = await this.getCachedSpec();
        const { hash } = await this.queryRef();
        const git = await this.getRepo().getGit();

        await git.fetch({ depth: 1 }, url, `+${hash}:${specRef}`);

        return this.getHead();
    }

    async getSubGit ({ required=false } = {}) {
        const envGit = await Git.get();
        const repo = this.getRepo();

        const subRepoPath = `.holo/sources/${this.name}`;
        const gitDir = path.join(repo.gitDir, 'modules', subRepoPath);
        const workTree = repo.workTree && path.join(repo.workTree, subRepoPath);

        if (!await fs.exists(gitDir)) {
            if (required) {
                throw new Error(`submodule ${subRepoPath} is not initialized; try running: git holo source checkout ${this.name}`);
            } else {
                return null;
            }
        }

        return new envGit.Git({
            gitDir,
            workTree: workTree && await fs.exists(workTree) ? workTree : null
        });
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


        // determine commit and path for subrepo
        const head = await this.getCachedHead();
        const subRepoPath = `.holo/sources/${this.name}`;


        // generate submodule config
        if (submodule) {
            const submoduleConfig = {
                path: subRepoPath,
                url,
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


            // stage head as gitlink
            await git.updateIndex({ add: true, cacheinfo: true }, `160000,${head},${subRepoPath}`);
        }


        // initialize sub-repository
        const subRepoGitDir = path.join(gitDir, 'modules', subRepoPath);
        const envGit = await Git.get();
        await envGit.init({ bare: true }, subRepoGitDir);


        // initialize sub-repository work tree
        const subWorkTree = path.join(workTree, subRepoPath);
        await mkdirp(subWorkTree);
        await fs.writeFile(`${subWorkTree}/.git`, `gitdir: ${path.relative(subWorkTree, subRepoGitDir)}\n`);


        // instantiate git client
        const subGit = await this.getSubGit();


        // configure two-way object sharing
        await subGit.addToConfigSet('objects/info/alternates', path.relative(`${subRepoGitDir}/objects`, `${gitDir}/objects`));
        await git.addToConfigSet('objects/info/alternates', path.relative(`${gitDir}/objects`, `${subRepoGitDir}/objects`));


        // configure sub-repository
        await subGit.config('core.bare', 'false');
        await subGit.config('core.worktree', path.relative(subRepoGitDir, subWorkTree));

        if (submodule) {
            await git.config(`submodule.${subRepoPath}.active`, 'true');
            await git.config(`submodule.${subRepoPath}.url`, url);
            await git.removeFromConfigSet('info/exclude', `${subRepoPath}/`);
        } else {
            await git.addToConfigSet('info/exclude', `${subRepoPath}/`);
        }


        // check out ref
        const shallowPath = `${subRepoGitDir}/shallow`;
        const shallowList = await fs.exists(shallowPath)
            ? new Set((await fs.readFile(shallowPath, 'ascii')).trim().split('\n'))
            : new Set();
        shallowList.add(head); // TODO: don't add if any ancestors already within
        await fs.writeFile(shallowPath, Array.from(shallowList.values()).join('\n')+'\n');

        await subGit.updateRef(ref, head);
        await subGit.symbolicRef('HEAD', ref);

        await subGit.checkout();


        // add remote
        await subGit.config(`remote.origin.url`, url);


        // configure upstream
        if (branch) {
            const remoteRef = `refs/remotes/origin/${branch}`;
            await subGit.updateRef(remoteRef, head);
            await subGit.updateRef('FETCH_HEAD', ref);

            await subGit.config(`branch.${branch}.remote`, 'origin');
            await subGit.config(`branch.${branch}.merge`, ref);
            await subGit.config(`branch.${branch}.rebase`, 'true');
            await subGit.config(`remote.origin.fetch`, `+${ref}:${remoteRef}`);
        } else {
            await subGit.config(`remote.origin.fetch`, `+${ref}:${ref}`);
        }


        // initialize FETCH_HEAD
        await subGit.fetch({ depth: 1 });


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
