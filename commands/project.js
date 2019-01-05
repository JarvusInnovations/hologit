exports.command = 'project <holobranch>';
exports.desc = 'Projects holobranch named <holobranch> and outputs resulting tree hash';

exports.builder = {
    'commit-branch': {
        describe: 'A target branch to commit the projected tree to',
        type: 'string'
    },
    'commit-message': {
        describe: 'A commit message to use if commit-branch is specified',
        type: 'string'
    },
    'ref': {
        describe: 'Commit ref to read holobranch from',
        default: 'HEAD'
    },
    'working': {
        describe: 'Set to use the (possibly uncommited) contents of the working tree',
        type: 'boolean',
        default: false
    },
    'lens': {
        describe: 'Whether to apply lensing to the composite tree',
        type: 'boolean',
        default: true
    },
    'fetch': {
        describe: 'Whether to fetch the latest commit for all sources while projecting',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function project ({
    holobranch,
    ref = 'HEAD',
    lens = true,
    working = false,
    debug = false,
    fetch = false,
    commitBranch = null,
    commitMessage = null
}) {
    const path = require('path');
    const logger = require('../lib/logger.js');
    const { Repo, Projection } = require('../lib');


    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // load holorepo
    const repo = await Repo.getFromEnvironment({ ref, working });
    const repoHash = await repo.resolveRef();


    // load git interface
    const git = await repo.getGit();


    // load workspace
    const workspace = await repo.getWorkspace();


    // fetch all sources
    if (fetch) {
        const sources = await workspace.getSources();

        for (const source of sources.values()) {
            const hash = await source.fetch(); // TODO: skip fetch if there is a submodule gitlink
            const { url, ref } = await source.getCachedConfig();
            logger.info(`fetched ${source.name} ${url}#${ref}@${hash.substr(0, 8)}`);
        }
    }


    // instantiate projection
    const projection = new Projection({
        branch: workspace.getBranch(holobranch)
    });


    // apply composition
    await projection.composite();


    // write and output pre-lensing hash if debug enabled
    if (debug) {
        logger.info('writing output tree before lensing...');
        const outputTreeHashBeforeLensing = await projection.output.root.write();
        logger.info('output tree before lensing:', outputTreeHashBeforeLensing);
    }


    if (lens) {
        // read lenses from projection workspace
        const lenses = await projection.output.getLenses();


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
            const lensTargetStack = await projection.output.root.getSubtreeStack(outputRoot, true);
            const lensTargetTree = lensTargetStack.pop();

            await lensTargetTree.merge(lensedTree, {
                mode: outputMerge
            });
        }


        // strip .holo/ from output
        logger.info('stripping .holo/ tree from output tree...');
        projection.output.root.deleteChild('.holo');
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
    const rootTreeHash = await projection.output.root.write();


    // prepare output
    let outputHash = rootTreeHash;


    // update targetBranch
    if (commitBranch) {
        const targetRef = `refs/heads/${commitBranch}`;

        const parents = [
            await git.revParse(targetRef, { $nullOnError: true })
        ];

        if (repoHash && !working) {
            parents.push(repoHash);
        }

        const commitHash = await git.commitTree(
            {
                p: parents,
                m: commitMessage || `Projected ${projection.branch.name} from ${await git.describe({ always: true, tags: true })}`
            },
            rootTreeHash
        );

        await git.updateRef(targetRef, commitHash);
        logger.info(`committed new tree to "${commitBranch}":`, commitHash);

        // change output to commit
        outputHash = commitHash;
    }


    // finished
    git.cleanup();

    logger.info('projection ready:');
    console.log(outputHash);
    return outputHash;
};
