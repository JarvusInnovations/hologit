const path = require('path');
const fs = require('mz/fs');
const parseUrl = require('parse-url');


const Git = require('./Git.js');
const Configurable = require('./Configurable.js');
const SpecObject = require('./SpecObject.js');


const specCache = new WeakMap();
const headCache = new WeakMap();


class Source extends Configurable {

    constructor ({ repo, name }) {
        super(...arguments);

        this.repo = repo;
        this.name = name;

        Object.freeze(this);
    }

    getKind () {
        return 'holosource';
    }

    getConfigPath () {
        return `.holo/sources/${this.name}.toml`;
    }

    getRepo () {
        return this.repo;
    }

    async readConfig () {
        const { name: repoName } = await this.repo.getCachedConfig();

        if (this.name == repoName) {
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

        const { hash } = await SpecObject.write(this.repo, 'source', data);

        const spec = {
            hash,
            ref: `refs/holo/sources/${hash}`,
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
        const git = await this.repo.getGit();
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
        const { local } = await this.getCachedConfig();

        if (local) {
            return await this.repo.resolveRef();
        }

        // try to get head from submodule gitlink
        let head = await this.repo.resolveRef(`${this.repo.ref}:.holo/sources/${this.name}`);

        // try to get head from specRef
        if (!head) {
            const { ref: specRef } = await this.getCachedSpec();
            head = await this.repo.resolveRef(specRef);
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
        const git = await this.repo.getGit();

        await git.fetch({ depth: 1 }, url, `+${hash}:${specRef}`);

        return hash;
    }

    async getSubmodule () {
        const envGit = await Git.get();

        const submodulePath = `.holo/sources/${this.name}`;
        const gitDir = path.join(this.repo.gitDir, 'modules', submodulePath);
        const workTree = path.join(this.repo.workTree, submodulePath);

        if (!await fs.exists(gitDir)) {
            throw new Error(`submodule ${submodulePath} is not initialized; try running: git holo source checkout ${this.name}`);
        }

        return new envGit.Git({
            gitDir,
            workTree: await fs.exists(workTree) ? workTree : null
        });
    }

    async checkoutSubmodule () {
        const mkdirp = require('mz-modules/mkdirp');

        const { gitDir, workTree } = this.repo;
        const git = await this.repo.getGit();
        const { url, ref } = await this.getCachedConfig();
        const branch = await this.getBranch();


        // get work tree
        if (!workTree) {
            throw new Error('no work tree found, cannot checkout submodule');
        }


        // generate submodule config
        const submodulePath = `.holo/sources/${this.name}`;
        const submoduleConfig = {
            path: submodulePath,
            url,
            shallow: 'true'
        };

        if (branch) {
            submoduleConfig.branch = branch;
        }


        // write submodule config
        for (const key in submoduleConfig) {
            await git.config({ file: '.gitmodules' }, `submodule.${submodulePath}.${key}`, submoduleConfig[key]);
        }
        await git.add('.gitmodules');


        // stage head as gitlink
        const head = await this.getCachedHead();
        await git.updateIndex({ add: true, cacheinfo: true }, `160000,${head},${submodulePath}`);


        // initialize submodule repository
        const submoduleGitDir = path.join(gitDir, 'modules', submodulePath);
        const envGit = await Git.get();
        await envGit.init({ bare: true }, submoduleGitDir);


        // have submodule use objects from main repository
        const submoduleAlternatesPath = `${submoduleGitDir}/objects/info/alternates`;
        const submoduleAlternatesList = await fs.exists(submoduleAlternatesPath)
            ? new Set((await fs.readFile(submoduleAlternatesPath, 'ascii')).trim().split('\n'))
            : new Set();
        submoduleAlternatesList.add(path.relative(`${submoduleGitDir}/objects`, `${gitDir}/objects`));
        await mkdirp(path.dirname(submoduleAlternatesPath));
        await fs.writeFile(submoduleAlternatesPath, Array.from(submoduleAlternatesList.values()).join('\n')+'\n');


        // have main repository use objects from submodule
        const alternatesPath = `${gitDir}/objects/info/alternates`;
        const alternatesList = await fs.exists(alternatesPath)
            ? new Set((await fs.readFile(alternatesPath, 'ascii')).trim().split('\n'))
            : new Set();
        alternatesList.add(path.relative(`${gitDir}/objects`, `${submoduleGitDir}/objects`));
        await mkdirp(path.dirname(alternatesPath));
        await fs.writeFile(alternatesPath, Array.from(alternatesList.values()).join('\n')+'\n');


        // initialize submodule work tree
        const submoduleWorkTree = path.join(workTree, submodulePath);
        await mkdirp(submoduleWorkTree);
        await fs.writeFile(`${submoduleWorkTree}/.git`, `gitdir: ${path.relative(submoduleWorkTree, submoduleGitDir)}\n`);


        // instantiate git client
        const submodule = await this.getSubmodule();


        // configure submodule
        await submodule.config('core.bare', 'false');
        await submodule.config('core.worktree', path.relative(submoduleGitDir, submoduleWorkTree));
        await submodule.config(`submodule.${submodulePath}.active`, 'true');
        await submodule.config(`submodule.${submodulePath}.url`, url);


        // check out ref
        const shallowPath = `${submoduleGitDir}/shallow`;
        const shallowList = await fs.exists(shallowPath)
            ? new Set((await fs.readFile(shallowPath, 'ascii')).trim().split('\n'))
            : new Set();
        shallowList.add(head); // TODO: don't add if any ancestors already within
        await fs.writeFile(shallowPath, Array.from(shallowList.values()).join('\n')+'\n');

        await submodule.updateRef(ref, head);
        await submodule.symbolicRef('HEAD', ref);

        await submodule.checkout();


        // add remote
        await submodule.config(`remote.origin.url`, url);


        // configure upstream
        if (branch) {
            const remoteRef = `refs/remotes/origin/${branch}`;
            await submodule.updateRef(remoteRef, head);
            await submodule.updateRef('FETCH_HEAD', ref);

            await submodule.config(`branch.${branch}.remote`, 'origin');
            await submodule.config(`branch.${branch}.merge`, ref);
            await submodule.config(`branch.${branch}.rebase`, 'true');
            await submodule.config(`remote.origin.fetch`, `+${ref}:${remoteRef}`);
        } else {
            await submodule.config(`remote.origin.fetch`, `+${ref}:${ref}`);
        }


        // initialize FETCH_HEAD
        await submodule.fetch({ depth: 1 });


        return {
            path: submodulePath,
            head,
            branch,
            url,
            ref,
            submodule
        };
    }

}

module.exports = Source;
