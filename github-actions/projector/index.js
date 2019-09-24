const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');

try {
    run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {
    core.startGroup('Installing Chef Habitat');
    await exec('wget https://raw.githubusercontent.com/habitat-sh/habitat/master/components/hab/install.sh');
    await exec('sudo bash install.sh');
    await io.rmRF('install.sh');
    core.endGroup();
}
