const stream = require('stream');
const Docker = require('dockerode');
const os = require('os');
const nodeCleanup = require('node-cleanup');


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
                logger.info('terminating studio container', container.id);
                container.stop().then(() => container.remove());
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
            logger.info('connected to docker on', socketPath);
        }

        return docker;
    }



    static async get (gitDir) {
        const cachedStudio = studioCache.get(gitDir);

        if (cachedStudio) {
            return cachedStudio;
        }


        // detect environmental studio
        if (process.env.STUDIO_TYPE) {
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


        // start a Docker container
        const docker = await Studio.getDocker();

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
                    'GIT_DIR=/git',
                    'GIT_WORK_TREE=/hab/cache',
                    `DEBUG=${process.env.DEBUG||''}`,
                    `HAB_LICENSE=accept-no-persist`
                ],
                WorkingDir: '/git',
                Volumes: {
                    '/git': {},
                    '/hab/cache': {},
                    // '/src': {}
                },
                HostConfig: {
                    Binds: [
                        `${gitDir}:/git`,
                        // `${__dirname.substr(0, __dirname.length-4)}:/src`
                    ],
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

            if (username) {
                logger.info('configuring container to use user: ${username}');
                await containerExec(container, '/bin/mkdir', '/home');
                await containerExec(container, '/bin/adduser', '-u', `${uid}`, '-D', username);
                await containerExec(container, '/bin/chmod', 'go+w', '/hab/cache');
                await containerExec(container, '/bin/find', '/hab/pkgs', '-maxdepth', '3', '-type', 'd', '-exec', 'chmod', `go+w`, '{}', ';');
                container.defaultUser = `${uid}:${gid}`;
            }

            const studio = new Studio({ gitDir, container });
            studioCache.set(gitDir, studio);
            return studio;

        } catch (err) {
            logger.error('container failed', err);

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
        if (this.isLocal()) {
            return require('../commands/lens/exec.js').handler({ spec });
        }

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


nodeCleanup(() => {
    Studio.cleanup();
    return true;
});


async function containerExec (container, ...command) {
    const options = typeof command[command.length-1] == 'object'
        ? command.pop()
        : {};

    logger.info('studio-exec:', ...command);

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
        execStream.output.on('end', () => resolve(output.join('').trim()));

        container.modem.demuxStream(execStream.output, outputStream, process.stderr);
    });
}


module.exports = Studio;
