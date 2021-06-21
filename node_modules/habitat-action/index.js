const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');
const cache = require('@actions/cache');
const fs = require('fs');


const CACHE_LOCK_PATH = '/hab/cache/artifacts/.cached';
const RESTORE_LOCK_PATH = '/hab/cache/artifacts/.restored';


// gather input
const deps = (core.getInput('deps') || '').split(/\s+/).filter(pkg => Boolean(pkg));
const supervisor = core.getInput('supervisor') == 'true'
    ? true
    : (
        !core.getInput('supervisor')
        ? false
        : core.getInput('supervisor').trim().split(/\s*\n\s*/).filter(svc => Boolean(svc))
    );
const cacheKey = core.getInput('cache-key') || `hab-artifacts-cache:${process.env.GITHUB_WORKFLOW}`;


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {
    core.exportVariable('HAB_NONINTERACTIVE', 'true');
    core.exportVariable('STUDIO_TYPE', 'default');


    const habEnv = {
        HAB_NONINTERACTIVE: 'true', // not effective for hab svc load output pending https://github.com/habitat-sh/habitat/issues/6260
        ...process.env
    };


    if (await io.which('hab')) {
        core.info('Chef Habitat already installed!');
    } else {
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


        // create hab user and group
        try {
            core.startGroup('Creating hab user');
            await exec('sudo groupadd hab');
            await exec('sudo useradd -g hab -G docker hab');
            await io.rmRF('/tmp/hab-install.sh');
        } catch (err) {
            core.setFailed(`Failed to create hab user: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }


        // enable `hab pkg install` without sudo
        try {
            core.startGroup('Enabling setuid and setgid for hab command');
            await exec('sudo chmod ug+s /usr/bin/hab');
        } catch (err) {
            core.setFailed(`Failed to enable setuid and setgid for hab command: ${err.message}`);
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
    }


    // restore cache
    if (fs.existsSync(RESTORE_LOCK_PATH)) {
        core.info(`Skipping restoring, ${RESTORE_LOCK_PATH} already exists`);
    } else {
        try {
            core.startGroup(`Restoring package cache`);

            core.info(`Initializing runner-writable /hab/cache/artifacts`);
            await exec(`sudo mkdir -p /hab/cache/artifacts`);
            await exec(`sudo chown runner -R /hab/cache/artifacts`);

            core.info(`Writing restore lock: ${RESTORE_LOCK_PATH}`);
            fs.writeFileSync(RESTORE_LOCK_PATH, '');

            console.info(`Calling restoreCache: ${cacheKey}`);
            const restoredCache = await cache.restoreCache(['/hab/cache/artifacts'], cacheKey);

            core.info(restoredCache ? `Restored cache ${restoredCache}` : 'No cache restored');

            core.info(`Re-writing restore lock: ${RESTORE_LOCK_PATH}`);
            fs.writeFileSync(RESTORE_LOCK_PATH, '');

            // .cached file is written at beginning of caching, and removed after restore to
            // guard against multiple post scripts trying to save the same cache
            if (fs.existsSync(CACHE_LOCK_PATH)) {
                core.info(`Erasing cache lock: ${CACHE_LOCK_PATH}`);
                await exec(`rm -v "${CACHE_LOCK_PATH}"`);
            }
        } catch (err) {
            core.setFailed(`Failed to restore package cache: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    // install deps
    if (deps.length) {
        try {
            core.startGroup(`Installing deps: ${deps.join(' ')}`);
            await exec('hab pkg install', deps, { env: habEnv });
        } catch (err) {
            core.setFailed(`Failed to install deps: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    // start supervisor
    if (supervisor) {
        try {
            core.startGroup('Starting supervisor');
            await exec(`sudo mkdir -p /hab/sup/default`);
            await exec('sudo --preserve-env setsid bash', ['-c', 'hab sup run > /hab/sup/default/sup.log 2>&1 &'], { env: habEnv });

            core.info('Waiting for supervisor...');
            await exec('bash', ['-c', 'until hab svc status; do echo -n "."; sleep .1; done; echo']);
        } catch (err) {
            core.setFailed(`Failed to start supervisor: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }

        if (Array.isArray(supervisor)) {
            for (const svc of supervisor) {
                try {
                    core.startGroup(`Loading service: ${svc}`);
                    await exec(`hab svc load ${svc}`, [], { env: habEnv });
                } catch (err) {
                    core.setFailed(`Failed to load service: ${err.message}`);
                    return;
                } finally {
                    core.endGroup();
                }
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
