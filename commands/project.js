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
    lens = true,
    working = false,
    debug = false,
    fetch = false,
    watch = false,
    commitBranch = null,
    commitMessage = null
}) {
    const logger = require('../lib/logger.js');
    const { Repo, Projection, Workspace, Studio } = require('../lib');


    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // load holorepo
    const repo = await Repo.getFromEnvironment({ ref, working });
    const parentCommit = await repo.resolveRef();


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


    /**
     * create a reusable block for the rest of the process so it can be repeated
     * in watch mode--until a more efficient watch response can be developed
     */
    let outputHash = await Projection.projectBranch(workspace.getBranch(holobranch), {
        debug,
        lens,
        commitBranch,
        commitMessage,
        parentCommit
    });
    console.log(outputHash);


    // watch for changes
    if (watch) {
        const { watching } = await repo.watch({
            callback: async (newTreeHash, newCommitHash=null) => {
                logger.info('watch new hash: %s (from:%s)', newTreeHash, newCommitHash||'unknown');

                const newWorkspace = new Workspace({
                    root: await repo.createTree({ hash: newTreeHash })
                });

                outputHash = await Projection.projectBranch(newWorkspace.getBranch(holobranch), {
                    debug,
                    lens,
                    commitBranch,
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
