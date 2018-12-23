const path = require('path');


const Configurable = require('./Configurable.js');
const Mapping = require('./Mapping.js');


const mappingCache = new WeakMap();


class Branch extends Configurable {

    constructor ({ repo, name }) {
        super(...arguments);

        this.repo = repo;
        this.name = name;

        Object.freeze(this);
    }

    getKind () {
        return 'holobranch';
    }

    getConfigPath () {
        return `.holo/branches/${this.name}.toml`;
    }

    getRepo () {
        return this.repo;
    }

    getMapping (key) {
        let cache = mappingCache.get(this);
        const cachedBranch = cache && cache.get(key);

        if (cachedBranch) {
            return cachedBranch;
        }


        // instantiate branch
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
        const treePath = `.holo/branches/${this.name}`;
        const mappings = new Map();

        let tree;
        try {
            tree = await this.repo.listTree(treePath);
        } catch (err) {
            return mappings;
        }

        for (const mappingPath in tree) {
            const key = path.basename(mappingPath, '.toml');

            // skip any file not ending in .toml
            if (key == mappingPath) {
                continue;
            }

            mappings.set(key, new Mapping({
                branch: this,
                key
            }));
        }


        return mappings;
    }

}


module.exports = Branch;
