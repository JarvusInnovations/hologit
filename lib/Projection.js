const path = require('path');


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

    async lens () {
        const repo = this.branch.getRepo();
        const git = await repo.getGit();


        // read lenses from projection workspace
        const lenses = await this.output.getLenses();


        // apply lenses
        for (const lens of lenses.values()) {
            const {
                input: {
                    root: inputRoot,
                    files: inputFiles
                },
                output: {
                    root: outputRoot,
                    merge: outputMerge
                }
            } = await lens.getCachedConfig();

            // build tree of matching files to input to lens
            logger.info(`building input tree for lens ${lens.name} from ${inputRoot == '.' ? '' : (path.join(inputRoot, '.')+'/')}{${inputFiles}}`);
            const { hash: specHash, ref: specRef } = await lens.buildSpec(await lens.buildInputTree());


            // check for existing output tree
            let outputTreeHash = await repo.resolveRef(`${specRef}^{tree}`);


            // apply lens if existing tree not found
            if (outputTreeHash) {
                logger.info(`found existing output tree matching holospec(${specHash})`);
            } else {
                outputTreeHash = await lens.execute(specHash);
            }


            // verify output
            if (!git.isHash(outputTreeHash)) {
                throw new Error(`no output tree hash was returned by lens ${lens.name}`);
            }


            // apply lense output to main output tree
            logger.info(`merging lens output tree(${outputTreeHash}) into /${outputRoot != '.' ? outputRoot+'/' : ''}`);

            const lensedTree = await repo.createTreeFromRef(outputTreeHash);
            const lensTargetStack = await this.output.root.getSubtreeStack(outputRoot, true);
            const lensTargetTree = lensTargetStack.pop();

            await lensTargetTree.merge(lensedTree, {
                mode: outputMerge
            });
        }


        // strip .holo/ from output
        logger.info('stripping .holo/ tree from output tree...');
        this.output.root.deleteChild('.holo');
    }

    async commit (ref, { mergeParent=null, commitMessage = null } = {}) {
        const repo = this.branch.getRepo();
        const git = await repo.getGit();

        const parents = [
            await git.revParse(ref, { $nullOnError: true })
        ];

        if (mergeParent) {
            parents.push(mergeParent);
        }

        const commitHash = await git.commitTree(
            {
                p: parents,
                m: commitMessage || `Projected ${this.branch.name} from ${await git.describe({ always: true, tags: true })}`
            },
            await this.output.root.write()
        );

        await git.updateRef(ref, commitHash);
        logger.info(`committed new tree to "${ref}": ${parents.join('+')}->${commitHash}`);

        return commitHash;
    }
}

module.exports = Projection;
