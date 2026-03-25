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

    constructor ({ root=null, sources=null, branches=null }) {
        if (!root || !(root instanceof TreeObject)) {
            throw new Error('root required, must be instance of TreeObject');
        }

        super(...arguments);

        this.root = root;

        // Pre-populated sources and branches for programmatic construction
        if (sources) {
            const cache = new Map();
            for (const [name, source] of Object.entries(sources)) {
                if (source instanceof Source) {
                    cache.set(name, source);
                } else {
                    // Accept plain config objects — construct Source with phantom
                    cache.set(name, new Source({ workspace: this, name, phantom: source }));
                }
            }
            sourceCache.set(this, cache);
        }

        if (branches) {
            const cache = new Map();
            for (const [name, branch] of Object.entries(branches)) {
                if (branch instanceof Branch) {
                    cache.set(name, branch);
                } else {
                    cache.set(name, new Branch({ workspace: this, name, phantom: branch }));
                }
            }
            branchMapCache.set(this, cache);
        }

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


        // build unsorted map via recursive discovery
        const childNameRe = /^([^\/]+)\.toml$/;
        const map = new Map();

        for (const childName in children) {
            if (children[childName].isTree) {
                // skip .lenses directories (e.g. "docs-site.lenses")
                if (childName.endsWith('.lenses')) {
                    continue;
                }

                // peek inside: if directory contains .toml files it defines
                // a branch's mappings; otherwise it's a namespace — recurse
                await this._discoverBranches(
                    children[childName], childName, childNameRe, map
                );
            } else {
                const nameMatches = childName.match(childNameRe);
                if (!nameMatches) {
                    continue;
                }
                const [,name] = nameMatches;
                map.set(name, this.getBranch(name));
            }
        }


        // cache and return map
        branchMapCache.set(this, map);
        return map;
    }

    async _discoverBranches (tree, prefix, childNameRe, map) {
        const treeChildren = await tree.getChildren();

        // check if this directory contains any .toml files directly
        let hasTomlFiles = false;
        for (const name in treeChildren) {
            if (!treeChildren[name].isTree && childNameRe.test(name)) {
                hasTomlFiles = true;
                break;
            }
        }

        if (hasTomlFiles) {
            // directory contains mappings — it defines a branch
            map.set(prefix, this.getBranch(prefix));
        } else {
            // no .toml files — it's a namespace, recurse into subdirectories
            for (const name in treeChildren) {
                if (!treeChildren[name].isTree || name.endsWith('.lenses')) {
                    continue;
                }

                await this._discoverBranches(
                    treeChildren[name], prefix + '/' + name, childNameRe, map
                );
            }
        }
    }

    getSource (name) {
        let cache = sourceCache.get(this);
        const cachedSource = cache && cache.get(name);

        if (cachedSource) {
            return cachedSource;
        }


        // instantiate source
        const source = new Source({
            workspace: this,
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

        // return cached map if available
        const cachedMap = sourceMapCache.get(this);
        if (cachedMap) {
            return cachedMap;
        }


        // read tree
        const tree = await this.root.getSubtree(`.holo/sources`);
        const children = tree ? await tree.getChildren() : {};


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
        // TODO: de-dupe this behavior with Branch.getLenses
        const edges = [];

        for (const name in lenses) {
            const lens = lenses[name];
            const { after, before } = await lens.getCachedConfig();

            if (after) {
                for (const afterLens of after) {
                    if (afterLens == '*') {
                        for (const otherLens in lenses) {
                            if (otherLens != name && after.indexOf(otherLens) == -1) {
                                after.push(otherLens);
                            }
                        }
                        continue;
                    }

                    edges.push([lenses[afterLens], lens]);
                }
            }

            if (before) {
                for (const beforeLens of before) {
                    if (beforeLens == '*') {
                        for (const otherLens in lenses) {
                            if (otherLens != name && before.indexOf(otherLens) == -1) {
                                before.push(otherLens);
                            }
                        }
                        continue;
                    }

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
