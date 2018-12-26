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

/**
 * Initialize a holobranch
 * - [X] Check if branch exists already (die for now, merge on top of later)
 * - [X] Try loading repo with js-git and loading a tree
 * - [ ] Initialize and fetch sources automatically if needed
 * - [X] Ensure sources have recipricol alternates
 * - [X] Move source repos to root .git/modules tree
 * - [X] register as submodule under .git/config
 * - [X] Create shallow for submodules
 * - [ ] Load sources and mounts from topBranch
 * - [ ] Loop sources and generate commit for each
 * - [ ] Merge new commit onto virtualBranch
 */
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
    const toposort = require('toposort');
    const logger = require('../lib/logger.js');
    const { Repo, Projection } = require('../lib');

    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // load holorepo
    const repo = await Repo.getFromEnvironment({ ref, working });
    const repoHash = await repo.resolveRef();


    // fetch all sources
    if (fetch) {
        const sources = await repo.getSources();

        for (const source of sources.values()) {
            const hash = await source.fetch();
            const { url, ref } = await source.getCachedConfig();
            logger.info(`fetched ${source.name} ${url}#${ref}@${hash.substr(0, 8)}`);
        }
    }


    // instantiate projection
    const projection = new Projection(repo.getBranch(holobranch));


    // read holobranch mappings
    logger.info('reading mappings from holobranch:', projection.branch);
    const mappings = await projection.branch.getMappings();


    // group mappings by layer
    const mappingsByLayer = {};
    for (const mapping of mappings.values()) {
        const { layer } = await mapping.getCachedConfig();

        if (mappingsByLayer[layer]) {
            mappingsByLayer[layer].push(mapping);
        } else {
            mappingsByLayer[layer] = [mapping];
        }
    }


    // compile edges formed by before/after requirements
    const mappingEdges = [];

    for (const mapping of mappings.values()) {
        const { after, before } = await mapping.getCachedConfig();

        if (after) {
            for (const layer of after) {
                for (const afterMapping of mappingsByLayer[layer]) {
                    mappingEdges.push([afterMapping, mapping]);
                }
            }
        }

        if (before) {
            for (const layer of before) {
                for (const beforeMapping of mappingsByLayer[layer]) {
                    mappingEdges.push([mapping, beforeMapping]);
                }
            }
        }
    }


    // sort specs by before/after requirements
    const sortedMappings = toposort.array(Array.from(mappings.values()), mappingEdges);


    // load git interface
    const git = await repo.getGit();


    // composite output tree
    logger.info('compositing tree...');
    for (const mapping of sortedMappings) {
        const { layer, root, files, output, holosource } = await mapping.getCachedConfig();

        logger.info(`merging ${layer}:${root != '.' ? root+'/' : ''}{${files}} -> /${output != '.' ? output+'/' : ''}`);

        // load source
        const source = await repo.getSource(holosource);
        const sourceHead = await source.getCachedHead();

        // load tree
        const sourceTree = await repo.createTreeFromRef(`${sourceHead}:${root == '.' ? '' : root}`);

        // merge source into target
        const targetTree = output == '.' ? projection.output : await projection.output.getSubtree(output, true);
        await targetTree.merge(sourceTree, {
            files: files
        });
    }


    // write and output pre-lensing hash if debug enabled
    if (debug) {
        logger.info('writing output tree before lensing...');
        const outputTreeHashBeforeLensing = await projection.output.write();
        logger.info('output tree before lensing:', outputTreeHashBeforeLensing);
    }


    if (lens) {
        // read lenses
        const lenses = await projection.getLenses();


        // apply lenses
        for (const lens of lenses) {
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
            const lensTargetStack = await projection.output.getSubtree(outputRoot, true, true);
            const lensTargetTree = lensTargetStack.pop();

            await lensTargetTree.merge(lensedTree, {
                mode: outputMerge
            });
        }


        // strip .holo/ from output
        logger.info('stripping .holo/ tree from output tree...');
        projection.output.deleteChild('.holo');
    } else {
        const holoTree = await projection.output.getSubtree('.holo');

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
    const rootTreeHash = await projection.output.write();


    // prepare output
    let outputHash = rootTreeHash;


    // update targetBranch
    if (commitBranch) {
        const targetRef = `refs/heads/${commitBranch}`;

        const commitHash = await git.commitTree(
            {
                p: [
                    await git.revParse(targetRef, { $nullOnError: true }),
                    repoHash
                ],
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
