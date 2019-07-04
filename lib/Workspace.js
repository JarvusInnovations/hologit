const toposort = require('toposort');


const TreeObject = require('./TreeObject.js');
const Configurable = require('./Configurable.js');
const Branch = require('./Branch.js');
const Source = require('./Source.js');
const Lens = require('./Lens.js');


const branchCache = new WeakMap();
const branchMapCache = new WeakMap();
const sourceCache = new WeakMap();
const sourceMapCache = new WeakMap();
const lensCache = new WeakMap();
const lensMapCache = new WeakMap();


class Workspace extends Configurable {

    constructor ({ root=null }) {
        if (!root || !(root instanceof TreeObject)) {
            throw new Error('root required, must be instance of TreeObject');
        }

        super(...arguments);

        this.root = root;

        Object.freeze(this);
    }

    getWorkspace () {
        return this;
    }

    getKind () {
        return 'holospace';
    }

    getConfigPath () {
        return '.holo/config.toml';
    }

    async writeWorkingChanges () {
        const { root } = this;

        if (!root.dirty) {
            return;
        }

        if (!root.repo.workTree) {
            throw new Error('cannot write working changes without work tree');
        }

        const git = await root.repo.getGit();
        const originalTreeHash = root.hash;
        await root.write();

        try {
            await git.readTree({ m: true, u: true }, originalTreeHash, root.hash);
        } catch (err) {
            throw new Error(`failed to apply changes to working tree:\n${err.stderr || err.message}`);
        }
    }

    getBranch (name) {
        let cache = branchCache.get(this);
        const cachedBranch = cache && cache.get(name);

        if (cachedBranch) {
            return cachedBranch;
        }


        // instantiate branch
        const branch = new Branch({
            workspace: this,
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

    async getBranches () {

        // return cached map if available
        const cachedMap = branchMapCache.get(this);
        if (cachedMap) {
            return cachedMap;
        }


        // read tree
        const tree = await this.root.getSubtree(`.holo/branches`);
        const children = tree ? await tree.getChildren() : {};


        // build unsorted map
        const childNameRe = /^([^\/]+)\.toml$/;
        const map = new Map();
        for (const childName in children) {
            let name;

            // process trees or files ending in .toml
            if (children[childName].isTree) {
                name = childName;
            } else {
                const nameMatches = childName.match(childNameRe);
                if (!nameMatches) {
                    continue;
                }
                [,name] = nameMatches;
            }

            map.set(name, this.getBranch(name));
        }


        // cache and return map
        branchMapCache.set(this, map);
        return map;
    }

    getSource (name) {
        let cache = sourceCache.get(this);
        const cachedSource = cache && cache.get(name);

        if (cachedSource) {
            return cachedSource;
        }


        // parse name
        const [holosourceName, holobranchName] = name.split('<', 2);


        // instantiate source
        let source = new Source({
            workspace: this,
            name: holosourceName
        });

        debugger;
        if (holobranchName) {
            source = new Source({
                workspace: this,
                parentSource: source,
                holobranch: holobranchName
            });
        }


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

        // return cached map if available
        const cachedMap = sourceMapCache.get(this);
        if (cachedMap) {
            return cachedMap;
        }


        // read tree
        const tree = await this.root.getSubtree(`.holo/sources`);
        const children = await tree.getChildren();


        // build unsorted map
        const childNameRe = /^([^\/]+)\.toml$/;
        const map = new Map();
        for (const childName in children) {
            const nameMatches = childName.match(childNameRe);

            // skip any file not ending in .toml
            if (!nameMatches) {
                continue;
            }

            const [,name] = nameMatches;

            map.set(name, this.getSource(name));
        }


        // cache and return map
        sourceMapCache.set(this, map);
        return map;
    }

    /**
     * Return an ordered Map of layers, each being an ordered Map of Mappings
     */
    async getLayers () {

    }

    getLens (name) {
        let cache = lensCache.get(this);
        const cachedLens = cache && cache.get(name);

        if (cachedLens) {
            return cachedLens;
        }


        // instantiate lens
        const lens = new Lens({
            workspace: this,
            name
        });


        // save instance to cache
        if (!cache) {
            cache = new Map();
            lensCache.set(this, cache);
        }

        cache.set(name, lens);


        // return instance
        return lens;
    }

    /**
     * Return an order list of Lens objects
     */
    async getLenses () {

        // return cached map if available
        const cachedMap = lensMapCache.get(this);

        if (cachedMap) {
            return cachedMap;
        }


        // read tree
        const tree = await this.root.getSubtree(`.holo/lenses`);
        const children = tree ? await tree.getChildren() : {};


        // build unsorted hash
        const childNameRe = /^([^\/]+)\.toml$/;
        const lenses = {};

        for (const childName in children) {

            // skip any child not ending in .toml
            const filenameMatches = childName.match(childNameRe);
            if (!filenameMatches) {
                continue
            }

            // skip any child that is deleted or isn't a blbo
            const treeChild = children[childName];
            if (!treeChild || !treeChild.isBlob) {
                continue;
            }

            // read lens
            const [, name] = filenameMatches;
            lenses[name] = this.getLens(name);
        }


        // compile edges formed by before/after requirements
        const edges = [];

        for (const name in lenses) {
            const lens = lenses[name];
            const { input: { after, before } } = await lens.getCachedConfig();

            if (after) {
                for (const afterLens of after) {
                    edges.push([lenses[afterLens], lens]);
                }
            }

            if (before) {
                for (const beforeLens of before) {
                    edges.push([lens, lenses[beforeLens]]);
                }
            }
        }


        // build map of lenses sorted by before/after requirements
        const map = new Map();

        for (const lens of toposort.array(Object.values(lenses), edges)) {
            map.set(lens.name, lens);
        }


        // cache and return map
        lensMapCache.set(this, map);
        return map;
    }

}

module.exports = Workspace;
