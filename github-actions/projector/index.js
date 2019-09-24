const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');


// gather input
const { GITHUB_ACTOR, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA } = process.env;

const holobranch = core.getInput('holobranch', { required: true });
const lens = core.getInput('lens');
const commitTo = core.getInput('commit-to', { required: false });
const commitToRef = commitTo == 'HEAD' || commitTo.startsWith('refs/')
    ? commitTo
    : `refs/heads/${commitTo}`;


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


    try {
        core.startGroup(`Fetching: ${commitToRef}`);
        await exec ('git fetch', [
            '--no-recurse-submodules',
            '--depth=1',
            'origin',
            `${commitToRef}:${commitToRef}`
        ]);
    } catch (err) {
        core.setFailed(`Failed to fetch commit-to ref: ${err.message}`);
        return;
    } finally {
        core.endGroup();
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


    try {
        core.startGroup(`Projecting holobranch: ${holobranch}`);
        await exec('hab studio run', [
            'hab pkg exec jarvus/hologit',
            'git holo project emergence-site',
            `--ref=${GITHUB_SHA}`,
            `--commit-to=${commitToRef}`
        ]);
    } catch (err) {
        core.setFailed(`Failed to project holobranch: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


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
