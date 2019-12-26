const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');


// gather input
const { GITHUB_ACTOR, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF } = process.env;

const debug = core.getInput('debug');
const ref = core.getInput('ref') || GITHUB_REF;
const holobranch = core.getInput('holobranch', { required: true });
const lens = core.getInput('lens');
const commitTo = core.getInput('commit-to', { required: false });
const commitToRef = commitTo
    ? (
        commitTo == 'HEAD' || commitTo.startsWith('refs/')
        ? commitTo
        : `refs/heads/${commitTo}`
    ) : null;


// run with error wrapper
try {
    run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {
    require('habitat-action');


    const repoInitialized = await exec('git rev-parse --git-dir', [], { ignoreReturnCode: true, silent: true }) === 0;
    if (!repoInitialized) {
        core.startGroup(`Initializing git repository: ${GITHUB_REPOSITORY}`);
        try {
            await holoExec('git init --bare');
            await holoExec('git remote add', [
                'origin',
                `https://${GITHUB_ACTOR}:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git`
            ]);
        } catch (err) {
            core.setFailed(`Failed to initialize git repository: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    try {
        core.startGroup(`Fetching: ${ref}`);
        await holoExec('git fetch', [
            '--tags',
            '--no-recurse-submodules',
            '--depth=1',
            'origin',
            `${ref}:${ref}`
        ]);

        const fetchedHash = await execOutput('git rev-parse', [ref]);
        core.info(`Fetched: ${fetchedHash}`);
    } catch (err) {
        core.setFailed(`Failed to fetch ref: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    if (commitToRef) {
        try {
            core.startGroup(`Fetching: ${commitToRef}`);
            await holoExec('git fetch', [
                '--no-recurse-submodules',
                '--depth=1',
                'origin',
                `${commitToRef}:${commitToRef}`
            ]);
        } catch (err) {
            core.info(`Failed to fetch commit-to ref: ${err.message}`);
        } finally {
            core.endGroup();
        }
    }


    let userName = '', userEmail = '';
    try {
        core.startGroup(`Reading author user name+email from ${ref}`);
        userName = await execOutput('git --no-pager log', ['-1', '--pretty=format:%an', ref]);
        userEmail = await execOutput('git --no-pager log', ['-1', '--pretty=format:%ae', ref]);
    } catch (err) {
        core.setFailed(`Failed to read user name+email: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    try {
        core.startGroup(`Setting git user: ${userName} <${userEmail}>`);
        await holoExec('git config user.name', [userName]);
        await holoExec('git config user.email', [userEmail]);
    } catch (err) {
        core.setFailed(`Failed to set git user: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    let oldTreeHash;
    if (commitToRef) {
        try {
            core.startGroup(`Saving hash of current tree: ${holobranch}`);
            oldTreeHash = await getTreeHash(commitToRef);
        } catch (err) {
            oldTreeHash = null;
        } finally {
            core.endGroup();
        }
    }


    try {
        core.startGroup(`Projecting holobranch: ${holobranch}`);
        const projectionArgs = [
            holobranch,
            `--ref=${ref}`,
            '--cache-from=origin',
            '--cache-to=origin'
        ];

        if (debug) {
            projectionArgs.push('--debug');
        }

        if (commitToRef) {
            projectionArgs.push(`--commit-to=${commitToRef}`);
        }

        if (lens == 'true') {
            projectionArgs.push('--lens');
        } else if (lens == 'false') {
            projectionArgs.push('--no-lens');
        }

        await holoExec('git holo project', projectionArgs);
    } catch (err) {
        core.setFailed(`Failed to project holobranch: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    if (commitToRef) {
        core.startGroup(`Saving hash of new tree: ${holobranch}`);
        const newTreeHash = await getTreeHash(commitToRef);
        core.endGroup();

        if (newTreeHash === oldTreeHash) {
            core.info('Tree unchanged, skipping push');
        } else {
            try {
                core.startGroup(`Pushing: ${commitToRef}`);
                await holoExec('git push', ['origin', commitToRef]);
            } catch (err) {
                core.setFailed(`Failed to push commit-to ref: ${err.message}`);
                return;
            } finally {
                core.endGroup();
            }
        }
    }
}

async function holoExec(command, args = []) {
    return exec('hab pkg exec jarvus/hologit', [
        command,
        ...args
    ]);
}

async function execOutput(commandLine, args = [], options = {}) {
    let stdout = '';

    await exec(commandLine, args, {
        ...options,
        listeners: {
            ...options.listeners,
            stdout: buffer => stdout += buffer
        }
    });

    return stdout.trim();
}

async function getTreeHash(ref) {
    return execOutput('git rev-parse', [`${ref}^{tree}`]);
}
