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

    async fetch () {
        const { url } = await this.getCachedConfig();
        const { ref: specRef } = await this.getCachedSpec();
        const { hash } = await this.queryRef();
        const git = await this.repo.getGit();

        await git.fetch({ depth: 1 }, url, `+${hash}:${specRef}`);

        return hash;
    }

}

module.exports = Source;
