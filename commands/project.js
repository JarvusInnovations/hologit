exports.command = 'project <holobranch>';
exports.desc = 'Projects holobranch named <holobranch> and outputs resulting tree hash';

exports.builder = {
    'commit-to': {
        describe: 'A target branch/ref to commit the projected tree to',
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
        default: null
    },
    'fetch': {
        describe: 'List of sources to fetch while projecting or * to fetch all',
        type: 'string'
    },
    'watch': {
        describe: 'Set to continously output updated output',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function project ({
    holobranch,
    ref = 'HEAD',
    lens = null,
    working = false,
    debug = false,
    fetch = null,
    watch = false,
    commitTo = null,
    commitMessage = null
}) {
    const logger = require('../lib/logger.js');
    const { Repo, Projection } = require('../lib');


    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // parse fetch list from options and env
    const fetchSplitRe = /[\s,:]+/;

    if (fetch || fetch === '') {
        if (fetch == '*' || !fetch) {
            fetch = true;
        } else if (!Array.isArray(fetch)) {
            fetch = fetch.split(fetchSplitRe);
        }
    }

    const fetchEnv = process.env.HOLO_FETCH;
    if (fetchEnv) {
        if (fetchEnv == '*' || fetch === true) {
            fetch = true;
        } else {
            (fetch || (fetch = [])).push(...fetchEnv.split(fetchSplitRe));
        }
    }


    // load holorepo
    const repo = await Repo.getFromEnvironment({ ref, working });
    const parentCommit = await repo.resolveRef();


    // load workspace
    const workspace = await repo.getWorkspace();


    // examine holobranch
    const workspaceBranch = workspace.getBranch(holobranch);
    if (!await workspaceBranch.isDefined()) {
        throw new Error(`holobranch not defined: ${holobranch}`);
    }


    /**
     * create a reusable block for the rest of the process so it can be repeated
     * in watch mode--until a more efficient watch response can be developed
     */
    let outputHash = await Projection.projectBranch(workspaceBranch, {
        debug,
        lens,
        commitTo,
        commitMessage,
        parentCommit,
        fetch
    });
    console.log(outputHash);


    // watch for changes
    if (watch) {
        const { watching } = await repo.watch({
            callback: async (newTreeHash, newCommitHash=null) => {
                logger.info('watch new hash: %s (from:%s)', newTreeHash, newCommitHash||'unknown');

                const newWorkspace = await repo.createWorkspaceFromTreeHash(newTreeHash);
                outputHash = await Projection.projectBranch(newWorkspace.getBranch(holobranch), {
                    debug,
                    lens,
                    commitTo,
                    commitMessage,
                    parentCommit: newCommitHash
                });
                console.log(outputHash);
            }
        });

        await watching;
    }


    // finished
    return outputHash;
};
