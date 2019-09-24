const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');

const { GITHUB_ACTOR, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF } = process.env;
const holobranch = core.getInput('holobranch', { required: true });
const commitTo = core.getInput('commit-to', { required: false });
const commitToRef = commitTo == 'HEAD' || commitTo.startsWith('refs/')
    ? commitTo
    : `refs/heads/${commitTo}`

try {
    run();
} catch(err) {
    core.setFailed(err.message);
}


async function run() {
    core.startGroup(`Initializing git repository: ${GITHUB_REPOSITORY}`);
    await exec('git init --bare');
    await exec('git remote add', [
        'origin',
        `https://${GITHUB_ACTOR}:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git`
    ]);
    core.endGroup();

    core.startGroup(`Fetching: ${GITHUB_REF}`);
    await exec ('git fetch', [
        '--tags',
        '--no-recurse-submodules',
        '--depth=1',
        'origin',
        `${GITHUB_REF}:${GITHUB_REF}`
    ]);
    core.endGroup();

    core.startGroup(`Fetching: ${commitToRef}`);
    await exec ('git fetch', [
        '--no-recurse-submodules',
        '--depth=1',
        'origin',
        `${commitToRef}:${commitToRef}`
    ]);
    core.endGroup();

    core.startGroup('Installing Chef Habitat');
    await exec('wget https://raw.githubusercontent.com/habitat-sh/habitat/master/components/hab/install.sh');
    await exec('sudo bash install.sh');
    await io.rmRF('install.sh');
    core.endGroup();

    core.startGroup('Initializing Habitat Studio');
    await exec('hab studio new');
    core.endGroup();

    core.startGroup('Installing Jarvus Hologit into Habitat Studio');
    await exec('hab studio run hab pkg install jarvus/hologit');
    core.endGroup();

    core.startGroup(`Projecting holobranch: ${holobranch}`);
    await exec('hab studio run', [
        'hab pkg exec jarvus/hologit',
        'git holo project emergence-site',
        `--ref=${GITHUB_SHA}`,
        `--commit-to=${commitToRef}`
    ]);
    core.endGroup();

    core.startGroup(`Pushing: ${commitToRef}`);
    await exec('git push', [commitToRef]);
    core.endGroup();
}
