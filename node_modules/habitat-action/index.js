const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');


// gather input
const deps = (core.getInput('deps') || '').split(/\s+/).filter(pkg => Boolean(pkg));


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {
    core.exportVariable('HAB_NONINTERACTIVE', 'true');
    core.exportVariable('STUDIO_TYPE', 'default');



    if (await io.which('hab')) {
        console.log('Chef Habitat already installed!');
        return;
    }

    // install hab binary and bootstrap /hab environment
    try {
        core.startGroup('Installing Chef Habitat');
        await exec('wget https://raw.githubusercontent.com/habitat-sh/habitat/master/components/hab/install.sh -O /tmp/hab-install.sh');
        await exec('sudo bash /tmp/hab-install.sh');
        await io.rmRF('/tmp/hab-install.sh');
    } catch (err) {
        core.setFailed(`Failed to install Chef Habitat: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    // reconfigure ownership so that `hab pkg install` works without sudo
    try {
        core.startGroup('Changing /hab ownership to runner user');
        await exec('sudo chown runner:docker -R /hab');
    } catch (err) {
        core.setFailed(`Failed to change /hab ownership: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    // verify installation (and initialize license)
    try {
        await exec('hab --version');
    } catch (err) {
        core.setFailed(`Failed to verify hab installation: ${err.message}`);
        return;
    }


    // link user cache directory to global
    try {
        core.startGroup('Linking ~/.hab/cache to /hab/cache');
        await exec(`mkdir -p "${process.env.HOME}/.hab"`);
        await exec(`ln -sf /hab/cache "${process.env.HOME}/.hab/"`);
    } catch (err) {
        core.setFailed(`Failed to link ~/.hab/cache: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    // install deps
    if (deps.length) {
        try {
            core.startGroup(`Installing deps: ${deps.join(' ')}`);
            await exec('hab pkg install', deps);
        } catch (err) {
            core.setFailed(`Failed to install deps: ${err.message}`);
            return;
        } finally {
            core.endGroup();
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
