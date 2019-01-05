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


    // update commitBranch
    if (commitBranch) {
        outputHash = await projection.commit(
            `refs/heads/${commitBranch}`,
            {
                mergeParent: working ? null : repoHash
            }
        );
    }


    // finished
    git.cleanup();

    logger.info('projection ready:');
    console.log(outputHash);
    return outputHash;
};
