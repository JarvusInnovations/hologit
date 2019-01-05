const logger = require('./logger');
const Workspace = require('./Workspace.js');


class Projection {

    constructor ({ branch }) {
        if (!branch) {
            throw new Error('branch required');
        }

        this.branch = branch;
        this.workspace = branch.workspace;
        this.output = new Workspace({
            root: branch.getRepo().createTree()
        });

        Object.freeze(this);
    }

    async composite () {
        const repo = this.branch.getRepo();


        // read holobranch mappings
        const mappings = await this.branch.getMappings();


        // composite output tree
        logger.info('compositing tree...');
        for (const mapping of mappings.values()) {
            const { layer, root, files, output, holosource } = await mapping.getCachedConfig();

            logger.info(`merging ${layer}:${root != '.' ? root+'/' : ''}{${files}} -> /${output != '.' ? output+'/' : ''}`);

            // load source
            const source = await this.workspace.getSource(holosource);
            const sourceHead = await source.getCachedHead();

            // load tree
            const sourceTree = await repo.createTreeFromRef(`${sourceHead}:${root == '.' ? '' : root}`);

            // merge source into target
            const targetTree = await this.output.root.getSubtree(output, true);
            await targetTree.merge(sourceTree, {
                files: files
            });
        }
    }
}

module.exports = Projection;
