const { spawn } = require('child_process');
const stream = require('stream');
const os = require('os');
const exitHook = require('async-exit-hook');
const fs = require('mz/fs');

const logger = require('./logger');

const studioCache = new Map();
let hab;

/**
 * Helper function to execute a Docker CLI command.
 * @param {Array<string>} args - The arguments to pass to the docker command.
 * @param {Object} options - Options for child_process.spawn.
 * @returns {Promise<string>} - Resolves with stdout data.
 */
function execDocker(args, options = { }) {
    logger.debug(`docker ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
        const dockerProcess = spawn('docker', args, { stdio: 'pipe', ...options });

        if (options.$relayStderr) {
            dockerProcess.stderr.pipe(process.stderr);
        }

        if (options.$relayStdout) {
            dockerProcess.stdout.pipe(process.stderr);
        }

        let stdout = '';
        let stderr = '';

        dockerProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        dockerProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        dockerProcess.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim()));
            }
        });
    });
}

/**
 * A studio session that can be used to run multiple commands, using chroot if available or docker container
 */
class Studio {

    static async cleanup () {
        let cleanupCount = 0;

        for (const [gitDir, studio] of studioCache) {
            const { container } = studio;

            if (container && container.type !== 'studio') {
                logger.info(`terminating studio container: ${container.id}`);
                try {
                    await execDocker(['stop', container.id]);
                    await execDocker(['rm', container.id]);
                    cleanupCount++;
                } catch (err) {
                    logger.error(`Failed to stop/remove container ${container.id}: ${err.message}`);
                }
            }

            studioCache.delete(gitDir);
        }

        if (cleanupCount > 0) {
            logger.debug(`cleaned up ${cleanupCount} studio${cleanupCount > 1 ? 's' : ''}`);
        }
    }

    static async getHab () {
        if (!hab) {
            hab = await require('hab-client').requireVersion('>=0.62');
        }

        return hab;
    }

    static async isEnvironmentStudio () {
        return Boolean(process.env.STUDIO_TYPE);
    }

    /**
     * Execute a Docker CLI command.
     * @param {Array<string>} args - The arguments to pass to the docker command.
     * @param {Object} options - Options for child_process.spawn.
     * @returns {Promise<string>} - Resolves with stdout data.
     */
    static execDocker(args, options = {}) {
        return execDocker(args, options);
    }

    static async get (gitDir) {
        const cachedStudio = studioCache.get(gitDir);

        if (cachedStudio) {
            return cachedStudio;
        }


        // detect environmental studio
        if (await Studio.isEnvironmentStudio()) {
            const studio = new Studio({
                gitDir,
                container: {
                    type: 'studio',
                    env: {
                        GIT_DIR: gitDir,
                        GIT_WORK_TREE: '/hab/cache'
                    }
                }
            });

            studioCache.set(gitDir, studio);

            return studio;
        }


        // pull latest studio container
        try {
            await execDocker(['pull', 'jarvus/hologit-studio:latest'], { $relayStdout: true, $relayStderr: true });
        } catch (err) {
            logger.error(`failed to pull studio image via docker: ${err.message}`);
        }


        // find artifact cache
        const volumesConfig = { '/git': {} };
        const bindsConfig = [ `${gitDir}:/git` ];

        let artifactCachePath;

        if (process.env.HOME) {
            artifactCachePath = `${process.env.HOME}/.hab/cache/artifacts`;

            if (!await fs.exists(artifactCachePath)) {
                artifactCachePath = null;
            }
        }

        if (!artifactCachePath) {
            artifactCachePath = '/hab/cache/artifacts';

            if (!await fs.exists(artifactCachePath)) {
                artifactCachePath = null;
            }
        }

        if (artifactCachePath) {
            volumesConfig['/hab/cache/artifacts'] = {};
            bindsConfig.push(`${artifactCachePath}:/hab/cache/artifacts`);
        }


        // create studio container
        let containerId;
        let defaultUser;
        try {
            // Prepare environment variables
            const envArgs = [
                '--env', 'STUDIO_TYPE=holo',
                '--env', 'GIT_DIR=/git',
                '--env', 'GIT_WORK_TREE=/hab/cache',
                '--env', `DEBUG=${process.env.DEBUG || ''}`,
                '--env', 'HAB_LICENSE=accept-no-persist'
            ];

            // Prepare volume bindings
            const volumeArgs = [];
            for (const bind of bindsConfig) {
                volumeArgs.push('-v', bind);
            }

            // Create container
            const createArgs = [
                'create',
                '--label', 'sh.holo.studio=yes',
                '--workdir', '/git',
                ...envArgs,
                ...volumeArgs,
                'jarvus/hologit-studio:latest'
            ];

            containerId = await execDocker(createArgs);
            containerId = containerId.split('\n').pop().trim(); // Get the container ID from output

            logger.info('starting studio container');
            await execDocker(['start', containerId]);

            const { uid, gid, username } = os.userInfo();

            if (uid && gid && username) {
                logger.info(`configuring container to use user: ${username}`);
                await containerExec({ id: containerId }, 'adduser', '-u', `${uid}`, '-G', 'developer', '-D', username);
                await containerExec({ id: containerId }, 'mkdir', '-p', `/home/${username}/.hab`);
                await containerExec({ id: containerId }, 'ln', '-sf', '/hab/cache', `/home/${username}/.hab/`);
                if (!artifactCachePath) await containerExec({ id: containerId }, 'chown', '-R', `${uid}:${gid}`, '/hab/cache');
                defaultUser = `${uid}`;
            }

            const studio = new Studio({ gitDir, container: { id: containerId, defaultUser } });
            studioCache.set(gitDir, studio);
            return studio;

        } catch (err) {
            logger.error(`container failed: ${err.message}`);

            if (containerId) {
                try {
                    await execDocker(['stop', containerId]);
                } catch (stopErr) {
                    logger.error(`Failed to stop container ${containerId}: ${stopErr.message}`);
                }
                try {
                    await execDocker(['rm', containerId]);
                } catch (rmErr) {
                    logger.error(`Failed to remove container ${containerId}: ${rmErr.message}`);
                }
            }
        }
    }

    constructor ({ gitDir, container }) {
        this.container = container;
        this.gitDir = gitDir;
        Object.freeze(this);
    }

    isLocal () {
        return this.container.type === 'studio';
    }

    /**
     * Run a command in the studio
     */
    async habExec (...command) {
        const options = typeof command[command.length-1] === 'object'
            ? command.pop()
            : {};

        if (this.isLocal()) {
            const hab = await Studio.getHab();

            const habProcess = await hab.exec(...command, {
                $spawn: true,
                $env: this.container.env,
                ...options
            });

            if (options.$relayStderr !== false) {
                habProcess.stderr.pipe(process.stderr);
            }

            return habProcess.captureOutputTrimmed();
        }

        return containerExec(this.container, 'hab', ...command, options);
    }

    async habPkgExec (pkg, bin, ...args) {
        return this.habExec('pkg', 'exec', pkg, bin, ...args);
    }

    async holoExec (...command) {
        // const holoPath = await this.exec('hab', 'pkg', 'path', 'jarvus/hologit');
        // const PATH = await this.exec('cat', `${holoPath}/RUNTIME_PATH`);
        // return this.exec(
        //     'node',
        //         '--inspect-brk=0.0.0.0:9229',
        //         '--nolazy',
        //         '/src/bin/cli.js',
        //             ...command,
        //     {
        //         $env: { PATH }
        //     }
        // );
        if (logger.level === 'debug') {
            command.unshift('--debug');
        }

        return this.habPkgExec('jarvus/hologit', 'git-holo', ...command);
    }

    async holoLensExec(spec) {
        return this.holoExec('lens', 'exec', spec);
    }

    async getPackage (query, { install } = { install: false }) {
        let packagePath;
        try {
            packagePath = await this.habExec('pkg', 'path', query, { $nullOnError: true, $relayStderr: false });
        } catch (err) {
            packagePath = null;
        }

        if (!packagePath && install) {
            await this.habExec('pkg', 'install', query);
            try {
                packagePath = await this.habExec('pkg', 'path', query);
            } catch (err) {
                packagePath = null;
            }
        }

        return packagePath ? packagePath.substr(10) : null;
    }
}

exitHook(callback => Studio.cleanup().then(callback));

/**
 * Executes a command inside the specified Docker container.
 * @param {Object} container - The container object containing at least the `id` and optionally `defaultUser`.
 * @param  {...string} command - The command and its arguments to execute.
 * @returns {Promise<string>} - Resolves with the command's stdout output.
 */
async function containerExec (container, ...command) {
    const options = typeof command[command.length-1] === 'object'
        ? command.pop()
        : {};

    logger.info(`studio-exec: ${command.join(' ')}`);

    const execArgs = ['exec'];

    if (options.$user) {
        execArgs.push('--user', options.$user);
    } else if (container.defaultUser) {
        execArgs.push('--user', container.defaultUser);
    }

    if (options.$env) {
        for (const [key, value] of Object.entries(options.$env)) {
            execArgs.push('--env', `${key}=${value}`);
        }
    }

    execArgs.push(container.id, ...command);

    try {
        const output = await execDocker(execArgs, { $relayStdout: true, $relayStderr: true });
        return output;
    } catch (err) {
        if (options.$nullOnError) {
            return null;
        }
        throw err;
    }
}

module.exports = Studio;
