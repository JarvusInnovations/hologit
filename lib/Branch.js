const toposort = require('toposort');


const logger = require('./logger');
const Configurable = require('./Configurable.js');
const Mapping = require('./Mapping.js');


const mappingCache = new WeakMap();
const mappingMapCache = new WeakMap();


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
        logger.info('reading mappings from holobranch:', this.name);
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
            const { after, before } = await mapping.getCachedConfig();

            if (after) {
                for (const layer of after) {
                    for (const afterMapping of mappingsByLayer[layer]) {
                        edges.push([afterMapping, mapping]);
                    }
                }
            }

            if (before) {
                for (const layer of before) {
                    for (const beforeMapping of mappingsByLayer[layer]) {
                        edges.push([mapping, beforeMapping]);
                    }
                }
            }
        }


        // build map of lenses sorted by before/after requirements
        const map = new Map();

        for (const mapping of toposort.array(Object.values(mappings), edges)) {
            map.set(mapping.key, mapping);
        }


        // cache and return map
        mappingMapCache.set(this, map);
        return map;
    }

    async composite (outputTree = this.getRepo().createTree()) {
        const repo = this.getRepo();
        const mappings = await this.getMappings();


        logger.info('compositing tree...');
        for (const mapping of mappings.values()) {
            const { layer, root, files, output, holosource } = await mapping.getCachedConfig();

            logger.info(`merging ${layer}:${root != '.' ? root+'/' : ''}{${files}} -> /${output != '.' ? output+'/' : ''}`);

            // load source
            debugger;
            const source = await this.workspace.getSource(holosource);
            debugger;
            const sourceHead = await source.getHead();
            debugger;

            // load tree
            const sourceTree = await repo.createTreeFromRef(`${sourceHead}:${root == '.' ? '' : root}`);

            // merge source into target
            const targetTree = await outputTree.getSubtree(output, true);
            await targetTree.merge(sourceTree, {
                files: files
            });
        }


        // return supplied or created tree
        return outputTree;
    }

}


Object.freeze(Branch.DEFAULT_CONFIG = {});


module.exports = Branch;
