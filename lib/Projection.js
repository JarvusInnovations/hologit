const toposort = require('toposort');


const Lens = require('./Lens.js');


const lensesCache = new WeakMap();


class Projection {

    constructor (branch) {
        this.branch = branch;
        this.repo = branch.repo;
        this.output = this.repo.createTree();

        Object.freeze(this);
    }

    /**
     * Return an ordered Map of layers, each being an ordered Map of Mappings
     */
    async getLayers () {

    }

    /**
     * Return an order list of Lens objects
     */
    async getLenses () {

        // return cached map if available
        const cachedLenses = lensesCache.get(this);
        if (cachedLenses) {
            return cachedLenses;
        }


        // read lenses tree
        const lensesTree = await this.output.getSubtree('.holo/lenses');
        const treeChildren = lensesTree ? await lensesTree.getChildren() : {};


        // build unsorted hash of lenses
        const filenameRe = /^([^\/]+)\.toml$/;
        const lenses = {};
        for (const filename in treeChildren) {

            // skip any child not ending in .toml
            const filenameMatches = filename.match(filenameRe);
            if (!filenameMatches) {
                continue
            }

            // skip any child that is deleted or isn't a blbo
            const treeChild = treeChildren[filename];
            if (!treeChild || !treeChild.isBlob) {
                continue;
            }

            // read lens
            const [, name] = filenameMatches;
            lenses[name] = new Lens({
                projection: this,
                name
            });
        }


        // compile edges formed by before/after requirements
        const lensEdges = [];

        for (const name in lenses) {
            const lens = lenses[name];
            const lensConfig = await lens.getCachedConfig();

            if (lensConfig.input.after) {
                for (const afterLens of lensConfig.input.after) {
                    lensEdges.push([lenses[afterLens], lens]);
                }
            }

            if (lensConfig.input.before) {
                for (const beforeLens of lensConfig.input.before) {
                    lensEdges.push([lens, lenses[beforeLens]]);
                }
            }
        }


        // return specs sorted by before/after requirements
        return new Set(toposort.array(Object.values(lenses), lensEdges));
    }
}

module.exports = Projection;
