const stream = require('stream');
const Docker = require('dockerode');
const os = require('os');
const exitHook = require('async-exit-hook');
const fs = require('mz/fs');


const logger = require('./logger');


const studioCache = new Map();
let hab, docker;


/**
 * A studio session that can be used to run multiple commands, using chroot if available or docker container
 */
class Studio {

    static async cleanup () {
        let cleanupCount = 0;

        for (const [gitDir, studio] of studioCache) {
            const { container } = studio;

            if (container && container.type != 'studio') {
                logger.info(`terminating studio container: ${container.id}`);
                await container.stop();
                await container.remove();
                cleanupCount++;
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

    static async getDocker () {
        if (!docker) {
            const { DOCKER_HOST: dockerHost } = process.env;
            const dockerHostMatch = dockerHost && dockerHost.match(/^unix:\/\/(\/.*)$/);
            const socketPath = dockerHostMatch ? dockerHostMatch[1] : '/var/run/docker.sock';

            docker = new Docker({ socketPath });
            logger.info(`connected to docker on: ${socketPath}`);
        }

        return docker;
    }

    static async isEnvironmentStudio () {
        return Boolean(process.env.STUDIO_TYPE);
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


        // connect with Docker API
        const docker = await Studio.getDocker();


        // pull latest studio container
        try {
            await new Promise((resolve, reject) => {
                docker.pull('jarvus/hologit-studio:latest', (streamErr, stream) => {
                    if (streamErr) {
                        reject(streamErr);
                        return;
                    }

                    let lastStatus;

                    docker.modem.followProgress(
                        stream,
                        (err, output) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(output);
                            }
                        },
                        event => {
                            if (event.status != lastStatus) {
                                logger.info(`docker pull: ${event.status}`);
                                lastStatus = event.status;
                            }
                        }
                    );
                });
            });
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


        // start studio container
        let container;
        try {
            container = await docker.createContainer({
                Image: 'jarvus/hologit-studio',
                Labels: {
                    'sh.holo.studio': 'yes'
                },
                AttachStdin: false,
                AttachStdout: true,
                AttachStderr: true,
                Env: [
                    'STUDIO_TYPE=holo',
                    'GIT_DIR=/git',
                    'GIT_WORK_TREE=/hab/cache',
                    `DEBUG=${process.env.DEBUG||''}`,
                    `HAB_LICENSE=accept-no-persist`
                ],
                WorkingDir: '/git',
                Volumes: volumesConfig,
                HostConfig: {
                    Binds: bindsConfig,
                    // ExposedPorts: {
                    //     "9229/tcp": { }
                    // },
                    // PortBindings: {
                    //     '9229/tcp': [
                    //         {
                    //             HostIp: '0.0.0.0',
                    //             HostPort: '9229'
                    //         }
                    //     ]
                    // }
                }
            });

            logger.info('starting studio container');
            await container.start();

            const { uid, gid, username } = os.userInfo();

            if (uid && gid && username) {
                logger.info(`configuring container to use user: ${username}`);
                await containerExec(container, 'adduser', '-u', `${uid}`, '-G', 'developer', '-D', username);
                await containerExec(container, 'mkdir', '-p', `/home/${username}/.hab`);
                await containerExec(container, 'ln', '-sf', '/hab/cache', `/home/${username}/.hab/`);
                container.defaultUser = `${uid}`;
            }

            const studio = new Studio({ gitDir, container });
            studioCache.set(gitDir, studio);
            return studio;

        } catch (err) {
            logger.error('container failed: %o', err);

            if (container) {
                await container.stop();
                await container.remove();
            }
        }
    }

    constructor ({ gitDir, container }) {
        this.container = container;
        this.gitDir = gitDir;
        Object.freeze(this);
    }

    isLocal () {
        return this.container.type == 'studio';
    }

    /**
     * Run a command in the studio
     */
    async habExec (...command) {
        const options = typeof command[command.length-1] == 'object'
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
        if (logger.level == 'debug') {
            command.unshift('--debug');
        }

        return this.habPkgExec('jarvus/hologit', 'git-holo', ...command);
    }

    async holoLensExec(spec) {
        return this.holoExec('lens', 'exec', spec);
    }

    async getPackage (query, { install } = { install: false }) {
        let packagePath = await this.habExec('pkg', 'path', query, { $nullOnError: true, $relayStderr: false });

        if (!packagePath && install) {
            await this.habExec('pkg', 'install', query);
            packagePath = await this.habExec('pkg', 'path', query);
        }

        return packagePath ? packagePath.substr(10) : null;
    }
}


exitHook(callback => Studio.cleanup().then(callback));


async function containerExec (container, ...command) {
    const options = typeof command[command.length-1] == 'object'
        ? command.pop()
        : {};

    logger.info(`studio-exec: ${command.join(' ')}`);

    const env = [];
    if (options.$env) {
        for (const key of Object.keys(options.$env)) {
            env.push(`${key}=${options.$env[key]}`);
        }
    }

    const exec = await container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: options.$relayStderr !== false,
        Env: env,
        User: `${container.defaultUser || options.$user || ''}`
    });

    const execStream = await exec.start();

    return new Promise((resolve, reject) => {
        const output = [];
        const outputStream = new stream.PassThrough();

        outputStream.on('data', chunk => output.push(chunk.toString('utf8')));
        execStream.on('end', () => resolve(output.join('').trim()));

        container.modem.demuxStream(execStream, outputStream, process.stderr);
    });
}


module.exports = Studio;
