const path = require('path');


const logger = require('./logger');
const hololib = require('.');
const RustEngine = require('./RustEngine.js');

class Projection {

    static async projectBranch (
        branch,
        {
            debug = false,
            lens = null,
            commitTo = null,
            commitMessage = null,
            parentCommit = null,
            fetch = false,
            cacheFrom = null,
            cacheTo = null
        } = {}
    ) {
        // instantiate projection
        const projection = new Projection({ branch });


        // apply composition — Rust engine when the projection shape allows,
        // JS engine otherwise (specs/behaviors/engine-selection.md)
        const rustTreeHash = await RustEngine.compositeBranch(branch, { fetch });

        if (rustTreeHash) {
            // adopt the Rust-composed pre-lens tree as the output root; the
            // JS pipeline (lensing, final strip, commit) continues on it
            await projection.output.root.merge(
                await branch.getRepo().createTreeFromRef(rustTreeHash),
                { mode: 'replace' }
            );
        } else {
            await projection.composite({ fetch, cacheFrom, cacheTo });
        }


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
                logger.info('output tree before lensing: %s', await projection.output.root.write());
            }

            await projection.lens({ cacheFrom, cacheTo });
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
                await projection.output.root.deleteChild('.holo');
            }
        }


        // write tree
        logger.info('writing final output tree...');
        let outputHash = await projection.output.root.write();


        // update commitTo
        if (commitTo) {
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

    async composite ({ fetch = false, cacheFrom = null, cacheTo = null }) {
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
            await branchStack.pop().composite({ outputTree: this.output.root, fetch, cacheFrom, cacheTo });
        }


        // merge projected holobranch onto output
        await this.branch.composite({ outputTree: this.output.root, fetch, cacheFrom, cacheTo });


        // strip .holo/{branches,sources} from output
        logger.info('stripping .holo/{branches,sources} tree from output tree...');
        const holoTree = await this.output.root.getSubtree('.holo');
        if (holoTree) {
            await holoTree.deleteChild('branches');
            await holoTree.deleteChild('sources');
        }
    }

    async lens ({ cacheFrom = null, cacheTo = null }) {
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
            const { hash: specHash } = await lens.buildSpec(await lens.buildInputTree(this.output.root));


            // check for existing output tree
            const outputTreeHash = await lens.executeSpec(specHash, { cacheFrom, cacheTo });


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
            await holoTree.deleteChild('lenses');
        }
    }

    async commit (ref, options = {}) {
        return Projection.commitTree(
            this.branch.getRepo(),
            this.branch.name,
            await this.output.root.write(),
            ref,
            options
        );
    }

    /**
     * Commit a projected tree to a target ref per
     * specs/behaviors/projection-commits.md — static so watch cycles can
     * gate publication (specs/behaviors/watch.md § Supersession) between
     * projecting and committing. Dispatches to the Rust engine when commits
     * are routed there (specs/behaviors/engine-selection.md § Commit
     * dispatch), with the JS path below remaining the conformance oracle
     * and default committer.
     */
    static async commitTree (repo, branchName, treeHash, ref, { parentCommit = null, commitMessage = null } = {}) {
        if (ref != 'HEAD' && !ref.startsWith('refs/')) {
            ref = `refs/heads/${ref}`;
        }

        const rustCommitHash = await RustEngine.commitProjection(repo, {
            commitRef: ref,
            holobranch: branchName,
            tree: treeHash,
            sourceCommit: parentCommit,
            commitMessage
        });
        if (rustCommitHash) {
            return rustCommitHash;
        }

        const git = await repo.getGit();

        let ancestor = await git.revParse(ref, { $nullOnError: true });
        if (!ancestor) {
            ancestor = await git.commitTree(hololib.TreeObject.getEmptyTreeHash(), {
                m: `↥ initialized ${branchName}`
            });
        }

        const parents = [ancestor];
        if (parentCommit) {
            parents.push(parentCommit);
        }

        const commitTrailers = [
            `Source-holobranch: ${branchName}`
        ];

        if (!repo.workTree) {
            if (parentCommit) {
                commitTrailers.push(`Source-commit: ${parentCommit}`);
            }
            commitTrailers.push(`Source: ${await git.describe({ always: true, tags: true }, repo.ref)}`);
        }

        const commitHash = await git.commitTree(treeHash, {
            p: parents,
            m: commitMessage || `☀ projected ${branchName} from ${repo.workTree || await git.describe({ always: true, tags: true }, repo.ref)}\n\n${commitTrailers.join('\n')}`
        });

        await git.updateRef(ref, commitHash);
        logger.info(`committed new tree to "${ref}": ${parents.join('+')}->${commitHash}`);

        return commitHash;
    }
}

module.exports = Projection;
