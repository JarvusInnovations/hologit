exports.command = 'pull [name]';
exports.desc = 'Pull the projected branch named <name> or --all';
exports.builder = {
    all: {
        describe: 'Fetch all projected branches',
        type: 'boolean',
        default: false
    },
    force: {
        describe: 'Force update existing local refs that are not ancestors of pulled ref',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function pull ({ name, all, force }) {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // check inputs
    if (!name && !all) {
        throw new Error('[name] or --all must be provided');
    }


    // get repo and git interface
    const repo = await Repo.getFromEnvironment();
    const git = await repo.getGit();


    // load workspace
    const workspace = await repo.getWorkspace();


    // get holobranch(es)
    const holobranchNames = all
        ? new Set((await workspace.getBranches()).keys())
        : new Set([name]);


    // get remote refs
    const remoteRefs = (await git.forEachRef('refs/remotes', { format: '%(refname)' })).split('\n');

    
    // check each remote ref
    for (const remoteRef of remoteRefs) {
        const [remoteCommit, remoteHolobranch] = (await git.show(remoteRef, { format: 'format:%H\n%(trailers:key=Source-holobranch,valueonly)' })).split('\n');

        // skip remotes without documented source holobranch on their latest commit
        if (!remoteHolobranch) {
            continue;
        }

        // skip remotes with a source holobranch that isn't defined in current workspace
        if (!holobranchNames.has(remoteHolobranch)) {
            continue;
        }

        // skip remotes that don't have a common ancestor
        if (!await git.mergeBase(repo.ref, remoteCommit, { $nullOnError: true })) {
            continue;
        }

        // examine local branch
        const branchName = remoteRef.substr(remoteRef.indexOf('/', 13) + 1);
        const localCommit = await repo.resolveRef(`refs/heads/${branchName}`);

        // skip already-matching local branch
        if (localCommit === remoteCommit) {
            continue;
        }

        // check that local commit is an ancestor, unless force is enabled
        if (localCommit && !force) {
            try {
                await git.mergeBase({ 'is-ancestor': true }, localCommit, remoteCommit);
            } catch (err) {
                logger.warn(`Existing local branch ${branchName} is not an ancestor of ${remoteRef}, skipping`);
                continue;
            }
        }

        // update local ref
        await git.updateRef(`refs/heads/${branchName}`, remoteCommit);
        logger.info(`Pulled ${branchName}: ${localCommit ? localCommit.substr(0, 8) : ''} -> ${remoteCommit.substr(0, 8)}`);
    }
};
