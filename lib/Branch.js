const toposort = require('toposort');


const logger = require('./logger');
const Configurable = require('./Configurable.js');
const Mapping = require('./Mapping.js');
const Lens = require('./Lens.js');


const mappingCache = new WeakMap();
const mappingMapCache = new WeakMap();
const lensCache = new WeakMap();
const lensMapCache = new WeakMap();


class Branch extends Configurable {

    constructor ({ workspace, name }) {
        if (!workspace) {
            throw new Error('workspace required');
        }

        if (!name) {
            throw new Error('name required');
        }

        super(...arguments);

        this.name = name;

        Object.freeze(this);
    }

    getKind () {
        return 'holobranch';
    }

    getConfigPath () {
        return `.holo/branches/${this.name}.toml`;
    }

    async readConfig () {
        return await super.readConfig() || Branch.DEFAULT_CONFIG;
    }

    async isDefined () {
        return await this.readConfig() !== Branch.DEFAULT_CONFIG || (await this.getMappings()).size;
    }

    getMapping (key) {
        let cache = mappingCache.get(this);
        const cachedBranch = cache && cache.get(key);

        if (cachedBranch) {
            return cachedBranch;
        }


        // instantiate mapping
        const mapping = new Mapping({
            branch: this,
            key
        });


        // save instance to cache
        if (!cache) {
            cache = new Map();
            mappingCache.set(this, cache);
        }

        cache.set(key, mapping);


        // return instance
        return mapping;
    }

    async getMappings () {

        // return cached map if available
        const cachedMap = mappingMapCache.get(this);

        if (cachedMap) {
            return cachedMap;
        }


        // read tree
        logger.info(`reading mappings from holobranch: ${this.name}`);
        const tree = await this.workspace.root.getSubtree(`.holo/branches/${this.name}`);


        // build unsorted hash and by-layer grouping
        const nameRe = /^([^\/]+)\.toml$/;
        const searchQueue = tree ? [{ prefix: '', tree }] : [];
        const mappings = {}, mappingsByLayer = {};

        while (searchQueue.length) {
            const { prefix, tree } = searchQueue.shift();
            const children = await tree.getChildren();

            for (const childName in children) {

                // enqueue child trees
                const child = children[childName];
                if (child.isTree) {
                    searchQueue.push({
                        prefix: prefix+childName+'/',
                        tree: child
                    });
                    continue;
                }

                // match .toml files
                const nameMatches = childName.match(nameRe);
                if (!nameMatches) {
                    continue;
                }

                // instantiate mapping
                const [,name] = nameMatches;
                const mapping = this.getMapping(prefix+name);
                mappings[mapping.key] = mapping;

                // group by layer
                const { layer } = await mapping.getCachedConfig();
                if (layer in mappingsByLayer) {
                    mappingsByLayer[layer].push(mapping);
                } else {
                    mappingsByLayer[layer] = [mapping];
                }
            }
        }


        // compile edges formed by before/after requirements
        const edges = [];

        for (const key in mappings) {
            const mapping = mappings[key];
            const { after, before, layer } = await mapping.getCachedConfig();

            if (after) {
                for (const afterLayer of after) {
                    if (afterLayer == '*') {
                        for (const otherLayer in mappingsByLayer) {
                            if (otherLayer != layer && after.indexOf(otherLayer) == -1) {
                                after.push(otherLayer);
                            }
                        }
                        continue;
                    }

                    if (!mappingsByLayer[afterLayer]) {
                        throw new Error(`layer ${afterLayer} not found, configured as 'after' requirement for mapping ${key}`);
                    }

                    for (const afterMapping of mappingsByLayer[afterLayer]) {
                        edges.push([afterMapping, mapping]);
                    }
                }
            }

            if (before) {
                for (const beforeLayer of before) {
                    if (beforeLayer == '*') {
                        for (const otherLayer in mappingsByLayer) {
                            if (otherLayer != layer && before.indexOf(otherLayer) == -1) {
                                before.push(otherLayer);
                            }
                        }
                        continue;
                    }

                    if (!mappingsByLayer[beforeLayer]) {
                        throw new Error(`layer ${beforeLayer} not found, configured as 'before' requirement for mapping ${key}`);
                    }

                    for (const beforeMapping of mappingsByLayer[beforeLayer]) {
                        edges.push([mapping, beforeMapping]);
                    }
                }
            }
        }


        // build map of mappings sorted by before/after requirements
        const map = new Map();

        for (const mapping of toposort.array(Object.values(mappings), edges)) {
            map.set(mapping.key, mapping);
        }


        // cache and return map
        mappingMapCache.set(this, map);
        return map;
    }

    async composite ({
        outputTree = this.getRepo().createTree(),
        fetch = false,
        cacheFrom = null,
        cacheTo = null
    }) {
        const repo = this.getRepo();
        const mappings = await this.getMappings();


        logger.info('compositing tree...');
        for (const mapping of mappings.values()) {
            const { layer, root, files, output, holosource } = await mapping.getCachedConfig();

            logger.info(`merging ${layer}:${root != '.' ? root+'/' : ''}{${files}} -> /${output != '.' ? output+'/' : ''}`);

            // load source
            const source = await this.workspace.getSource(holosource);

            if (
                fetch === true
                || (Array.isArray(fetch) && fetch.indexOf(source.holosourceName) >= 0)
            ) {
                const originalHash = await source.getHead();
                await source.fetch();
                const hash = await source.getHead();
                const { url, ref } = await source.getCachedConfig();

                if (hash == originalHash) {
                    logger.info(`${source.name}@${hash.substr(0, 8)} up-to-date`);
                } else {
                    logger.info(`${source.name}@${originalHash.substr(0, 8)}..${hash.substr(0, 8)} fetched ${url}#${ref}`);
                }
            }

            // load tree
            const sourceTreeHash = await source.getOutputTree({ fetch, cacheFrom, cacheTo });
            const sourceTree = await repo.createTreeFromRef(`${sourceTreeHash}:${root == '.' ? '' : root}`);

            // merge source into target
            const targetTree = await outputTree.getSubtree(output, true);
            // TODO: investigate why this crashes when a submodule commit is present at the target tree path
            await targetTree.merge(sourceTree, {
                files: files
            });
        }


        // return supplied or created tree
        return outputTree;
    }

    getLens (name) {
        let cache = lensCache.get(this);
        const cachedLens = cache && cache.get(name);

        if (cachedLens) {
            return cachedLens;
        }


        // instantiate lens
        const lens = new Lens({
            workspace: this.workspace,
            name,
            path: `.holo/branches/${this.name}.lenses/${name}.toml`
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
        const tree = await this.workspace.root.getSubtree(`.holo/branches/${this.name}.lenses`);
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

            // skip any child that is deleted or isn't a blob
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


Object.freeze(Branch.DEFAULT_CONFIG = {});


module.exports = Branch;
