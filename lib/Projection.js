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
            parentCommit = null,
            fetch = false
        } = {}
    ) {
        // instantiate projection
        const projection = new Projection({ branch });


        // apply composition
        await projection.composite({ fetch });


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
        }


        // strip .holo/config.toml from output if it's all that's left of .holo/
        const holoTree = await projection.output.root.getSubtree('.holo');
        if (holoTree) {
            let empty = true;
            const children = await holoTree.getChildren();

            for (const childName in children) {
                if (childName != 'config.toml' && children[childName]) {
                    empty = false;
                    break;
                }
            }

            if (empty) {
                logger.info('stripping empty .holo/ tree from output tree...');
                projection.output.root.deleteChild('.holo');
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

    async composite ({ fetch = false }) {
        const branchStack = [];

        // merge extended holobranch onto output first
        let { extend } = await this.branch.getCachedConfig();
        while (extend) {
            const extendBranch = this.workspace.getBranch(extend);
            if (!extendBranch) {
                throw new Error(`could not load holobranch for extend value: ${extend}`);
            }

            branchStack.push(extendBranch);

            const { extend: nextExtend } = await extendBranch.getCachedConfig();
            extend = nextExtend;
        }

        while (branchStack.length) {
            await branchStack.pop().composite({ outputTree: this.output.root, fetch });
        }


        // merge projected holobranch onto output
        await this.branch.composite({ outputTree: this.output.root, fetch });


        // strip .holo/{branches,sources} from output
        logger.info('stripping .holo/{branches,sources} tree from output tree...');
        const holoTree = await this.output.root.getSubtree('.holo');
        if (holoTree) {
            holoTree.deleteChild('branches');
            holoTree.deleteChild('sources');
        }
    }

    async lens () {
        const repo = this.branch.getRepo();
        const git = await repo.getGit();


        // read internal lenses from projection workspace
        const internalLenses = await this.output.getLenses();

        // read external lenses from input workspace
        const externalLenses = await this.branch.getLenses();

        // apply lenses
        for (const lens of [...internalLenses.values(), ...externalLenses.values()]) {
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
            const { hash: specHash, ref: specRef } = await lens.buildSpec(await lens.buildInputTree(this.output.root));


            // check for existing output tree
            let outputTreeHash = await git.getTreeHash(specRef, { verify: false });


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


        // strip .holo/lenses from output
        logger.info('stripping .holo/lenses tree from output tree...');
        const holoTree = await this.output.root.getSubtree('.holo');
        if (holoTree) {
            holoTree.deleteChild('lenses');
        }
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
                m: commitMessage || `Projected ${this.branch.name} from ${repo.workTree || await git.describe({ always: true, tags: true }, repo.ref)}`
            },
            await this.output.root.write()
        );

        await git.updateRef(ref, commitHash);
        logger.info(`committed new tree to "${ref}": ${parents.join('+')}->${commitHash}`);

        return commitHash;
    }
}

module.exports = Projection;
