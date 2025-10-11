const core = require('@actions/core');
const { exec } = require('@actions/exec');


// gather input
const { GITHUB_ACTOR, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF } = process.env;

const debug = core.getInput('debug');
const ref = core.getInput('ref') || GITHUB_REF;
const fetch = core.getInput('fetch') !== 'false';
const holobranch = core.getInput('holobranch', { required: true });
const lens = core.getInput('lens');
const commitTo = core.getInput('commit-to', { required: false });
const cache = core.getInput('cache') !== 'false';
const commitToRef = commitTo
    ? (
        commitTo == 'HEAD' || commitTo.startsWith('refs/')
        ? commitTo
        : `refs/heads/${commitTo}`
    ) : null;


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {
    // check if git-holo is already installed
    const isInstalled = await exec('which', ['git-holo'], { ignoreReturnCode: true, silent: true }) === 0;

    if (isInstalled) {
        core.info('Hologit is already installed, skipping npm install');
    } else {
        try {
            core.startGroup('Installing Jarvus Hologit');
            await exec('npm install -g hologit');
        } catch (err) {
            core.setFailed(`Failed to install Jarvus Hologit: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    const repoInitialized = await gitExec('rev-parse', ['--git-dir'], { ignoreReturnCode: true, silent: true }) === 0;
    if (!repoInitialized) {
        core.startGroup(`Initializing git repository: ${GITHUB_REPOSITORY}`);
        try {
            await gitExec('init', ['--bare']);
            await gitExec('remote', [
                'add',
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


    if (fetch) {
        try {
            core.startGroup(`Fetching: ${ref}`);
            await gitExec('fetch', [
                '--tags',
                '--no-recurse-submodules',
                '--depth=1',
                '--force',
                'origin',
                `${ref}:${ref}`
            ]);

            const fetchedHash = await gitExecOutput('rev-parse', [ref]);
            core.info(`Fetched: ${fetchedHash}`);
        } catch (err) {
            core.setFailed(`Failed to fetch ref: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    } else {
        core.info('Skipping fetch');
    }


    if (commitToRef) {
        try {
            core.startGroup(`Fetching: ${commitToRef}`);
            await gitExec('fetch', [
                '--no-recurse-submodules',
                '--depth=1',
                '--force',
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
        userName = await gitExecOutput('log', ['-1', '--pretty=format:%an', ref]);
        userEmail = await gitExecOutput('log', ['-1', '--pretty=format:%ae', ref]);
    } catch (err) {
        core.setFailed(`Failed to read user name+email: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    try {
        core.startGroup(`Setting git user: ${userName} <${userEmail}>`);
        await gitExec('config', ['user.name', userName]);
        await gitExec('config', ['user.email', userEmail]);
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
            `--ref=${ref}`
        ];

        if (cache) {
            projectionArgs.push('--cache-from=origin', '--cache-to=origin');
        } else {
            projectionArgs.push('--no-cache-from', '--no-cache-to');
        }

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

        const projectionHash = await gitExecOutput('holo', ['project', ...projectionArgs]);

        // set output
        if (commitToRef) {
            core.setOutput('commit', projectionHash);
            core.setOutput('tree', await getTreeHash(projectionHash));
        } else {
            core.setOutput('tree', projectionHash);
        }
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
                await gitExec('push', ['origin', commitToRef]);
            } catch (err) {
                core.setFailed(`Failed to push commit-to ref: ${err.message}`);
                return;
            } finally {
                core.endGroup();
            }
        }
    }
}

async function gitExec(command, args = [], options = {}) {
    return exec('git', [
        '--no-pager',
        command,
        ...args
    ], options);
}

async function gitExecOutput(command, args = [], options = {}) {
    return execOutput('git', [
        '--no-pager',
        command,
        ...args
    ], options);
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
    return gitExecOutput('rev-parse', [`${ref}^{tree}`]);
}
