const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');


// gather input
const { GITHUB_ACTOR, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA } = process.env;

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
    const repoInitialized = await exec('git rev-parse --git-dir', [], { ignoreReturnCode: true, silent: true }) === 0;

    if (!repoInitialized) {
        core.startGroup(`Initializing git repository: ${GITHUB_REPOSITORY}`);
        try {
            await exec('git init --bare');
            await exec('git remote add', [
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
        core.startGroup(`Fetching: ${GITHUB_REF}`);
        await exec ('git fetch', [
            '--tags',
            '--no-recurse-submodules',
            '--depth=1',
            'origin',
            `${GITHUB_REF}:${GITHUB_REF}`
        ]);
    } catch (err) {
        core.setFailed(`Failed to fetch GITHUB_REF: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    if (commitToRef) {
        try {
            core.startGroup(`Fetching: ${commitToRef}`);
            await exec ('git fetch', [
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


    if (!await io.which('hab')) {
        try {
            core.startGroup('Installing Chef Habitat');
            await exec('wget https://raw.githubusercontent.com/habitat-sh/habitat/master/components/hab/install.sh');
            await exec('sudo bash install.sh');
            await io.rmRF('install.sh');
        } catch (err) {
            core.setFailed(`Failed to install Chef Habitat: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    try {
        core.startGroup('Initializing Habitat Studio');
        await exec('hab studio new');
    } catch (err) {
        core.setFailed(`Failed to initialize Habitat Studio: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    try {
        core.startGroup('Installing Jarvus Hologit into Habitat Studio');
        await exec('hab studio run hab pkg install jarvus/hologit');
    } catch (err) {
        core.setFailed(`Failed to install Jarvus Hologit: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    let userName = '', userEmail = '';
    try {
        core.startGroup(`Reading author user name+email from ${GITHUB_REF}`);
        await exec('git --no-pager log', ['-1', '--pretty=format:%an'], {
            listeners: { stdout: buffer => userName += buffer }
        });
        await exec('git --no-pager log', ['-1', '--pretty=format:%ae'], {
            listeners: { stdout: buffer => userEmail += buffer }
        });
    } catch (err) {
        core.setFailed(`Failed to read user name+email: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    try {
        core.startGroup(`Setting git user: ${userName} <${userEmail}>`);
        await exec('git config user.name', [userName]);
        await exec('git config user.email', [userEmail]);
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
            `--ref=${GITHUB_SHA}`
        ];

        if (commitToRef) {
            projectionArgs.push(`--commit-to=${commitToRef}`);
        }

        if (lens == 'true') {
            projectionArgs.push('--lens');
        } else if (lens == 'false') {
            projectionArgs.push('--no-lens');
        }

        await execOutput('hab studio run', [
            'hab pkg exec jarvus/hologit',
            'git holo project',
            ...projectionArgs
        ]);

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
                await exec('git push', ['origin', commitToRef]);
            } catch (err) {
                core.setFailed(`Failed to push commit-to ref: ${err.message}`);
                return;
            } finally {
                core.endGroup();
            }
        }
    }
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
