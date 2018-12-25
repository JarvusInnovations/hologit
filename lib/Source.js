const parseUrl = require('parse-url');


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
        const { local, specRef } = await this.getCachedConfig();

        if (local) {
            return await this.repo.resolveRef();
        }

        // try to get head from submodule gitlink
        let head = await this.repo.resolveRef(`${this.repo.ref}:.holo/sources/${this.name}`);

        // try to get head from specRef
        if (!head) {
            head = await this.repo.resolveRef(specRef);
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

    // constructor (repo, name, properties = {}) {
    //     this.repo = repo;
    //     this.name = name;

    //     if (name == this.repo.config.holo.name) {
    //         this.local = true;
    //     }

    //     Object.assign(this, properties); // TODO: no, accept only config
    // }

    // getLocalRef () {
    //     return `refs/holo/sources/${this.name}/${this.config.holosource.ref.substr(5)}`;
    // }

    // async init () {
    //     // get git working tree
    //     const repoWorkTree = await this.repo.git.constructor.getWorkTreeFromEnvironment();
    //     if (!repoWorkTree) {
    //         throw new Error('must run with a git working tree');
    //     }


    //     // initialize repository
    //     const sourcePath = `.holo/sources/${this.name}`;
    //     const workTree = `${repoWorkTree}/${sourcePath}`;
    //     const gitDir = `${this.repo.gitDir}/modules/${sourcePath}`;

    //     logger.info(`initializing ${workTree}`);
    //     await mkdirp(gitDir);
    //     await this.repo.git.init({ 'separate-git-dir': gitDir }, workTree);


    //     // use main repo's objects database as alternate
    //     const alternatesConfigPath = `${gitDir}/objects/info/alternates`;
    //     logger.info(`configuring ${alternatesConfigPath}`);
    //     await fs.writeFile(alternatesConfigPath, path.relative(`${gitDir}/objects`, `${this.repo.gitDir}/objects`));


    //     // save git instance
    //     this.git = new this.repo.git.Git({ workTree, gitDir });
    // }

    // async fetch () {
    //     const { url, ref } = this.config.holosource;
    //     const localRef = this.getLocalRef();


    //     // fetch current head first
    //     if (this.head) {
    //         logger.info(`fetching head ${ref}@${this.head}`);
    //         await this.repo.git.fetch({ depth: 1 }, url, `+${this.head}:${localRef}`);
    //     }


    //     // examine remote repo/branch
    //     logger.info(`listing ${url}#${ref}`);
    //     const lsRemoteOutput = await this.repo.git.lsRemote(url, ref);
    //     const match = lsRemoteOutput.match(/^([0-9a-f]{40})\t(\S+)$/m);

    //     if (!match) {
    //         throw new Error(`could not find remote ref for ${ref}`);
    //     }

    //     const hash = match[1];


    //     // fetch remote head
    //     if (hash != this.head) {
    //         logger.info(`fetching remote ${ref}@${hash}`);
    //         await this.repo.git.fetch({ depth: 1 }, url, `+${hash}:${localRef}`);
    //     }

    //     return hash;
    // }

    // async loadHead () {
    //     if (this.local) {
    //         this.head = await this.repo.git.revParse({ verify: true }, 'HEAD');
    //     } else {
    //         try {
    //             this.head = await this.repo.git.revParse({ verify: true }, `HEAD:.holo/sources/${this.name}`);
    //         } catch (err) {
    //             this.head = await this.fetch();
    //         }
    //     }

    //     return true;
    // }

    // async loadGit () {

    //     if (this.local) {
    //         this.git = this.repo.git;
    //     } else {
    //         const workTree = `${this.repo.workTree}/.holo/sources/${this.name}`;

    //         if (await fs.exists(workTree)) {
    //             let gitDir = `${workTree}/.git`;

    //             try {
    //                 const gitDirStat = await fs.stat(gitDir);

    //                 // if .git is a file, read gitdir from it
    //                 if (gitDirStat.isFile()) {
    //                     const gitFileContent = await fs.readFile(gitDir, 'ascii');
    //                     const gitFileMatch = gitFileContent.match(/^gitdir: (\S+)/);

    //                     if (!gitFileMatch) {
    //                         throw new Error(`could not parse gitdir from file: ${gitDir}`);
    //                     }

    //                     gitDir = path.join(gitDir, '..', gitFileMatch[1]);
    //                 }

    //                 this.git = new this.repo.git.Git({ gitDir, workTree });
    //             } catch (err) {
    //                 if (err.code != 'ENOENT') {
    //                     throw err;
    //                 }

    //                 // it's ok for git dir to not exist, just don't set this.git
    //             }
    //         }
    //     }
    // }

    // getBranch () {
    //     const branchMatch = this.config.holosource.ref.match(/^refs\/heads\/(\S+)$/);

    //     return branchMatch ? branchMatch[1] : null;
    // }
}

module.exports = Source;
