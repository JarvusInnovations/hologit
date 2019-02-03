const path = require('path');


const logger = require('./logger');
const hololib = require('.');

class Projection {

    static async projectBranch (
        branch,
        {
            debug = false,
            lens = null,
            commitTo = null,
            commitMessage = null,
            parentCommit = null
        } = {}
    ) {
        // instantiate projection
        const projection = new Projection({ branch });


        // apply composition
        await projection.composite();


        // apply lensing
        if (lens === null) {
            ({ lens } = await branch.getCachedConfig());

            if (typeof lens != 'boolean') {
                lens = true;
            }
        }

        if (lens) {
            // write and output pre-lensing hash if debug enabled
            if (debug) {
                logger.info('writing output tree before lensing...');
                logger.info('output tree before lensing:', await projection.output.root.write());
            }

            await projection.lens();
        } else {
            const holoTree = await projection.output.root.getSubtree('.holo');

            if (holoTree) {
                for (const childName in await holoTree.getChildren()) {
                    if (childName != 'lenses') {
                        holoTree.deleteChild(childName);
                    }
                }
            }
        }


        // write tree
        logger.info('writing final output tree...');
        let outputHash = await projection.output.root.write();


        // update commitTo
        if (commitTo) {
            if (commitTo != 'HEAD' && !commitTo.startsWith('refs/')) {
                commitTo = `refs/heads/${commitTo}`;
            }

            outputHash = await projection.commit(commitTo, { parentCommit, commitMessage });
        }


        // output result
        logger.info('projection ready');
        return outputHash;
    }

    constructor ({ branch }) {
        if (!branch) {
            throw new Error('branch required');
        }

        this.branch = branch;
        this.workspace = branch.workspace;
        this.output = new hololib.Workspace({
            root: branch.getRepo().createTree()
        });

        Object.freeze(this);
    }

    async composite () {
        const { extend } = await this.branch.getCachedConfig();


        // merge extended holobranch onto output first
        if (extend) {
            const extendBranch = this.workspace.getBranch(extend);

            if (!extendBranch) {
                throw new Error(`could not load holobranch for extend value: ${extend}`);
            }

            await extendBranch.composite(this.output.root);
        }


        // merge projected holobranch onto output
        await this.branch.composite(this.output.root);
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

    async commit (ref, { parentCommit=null, commitMessage = null } = {}) {
        const repo = this.branch.getRepo();
        const git = await repo.getGit();

        const parents = [
            await git.revParse(ref, { $nullOnError: true })
        ];

        if (parentCommit) {
            parents.push(parentCommit);
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
