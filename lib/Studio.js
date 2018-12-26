const stream = require('stream');
const Docker = require('dockerode');


const logger = require('./logger');


const studioCache = new Map();
let hab, docker;


/**
 * A studio session that can be used to run multiple commands, using chroot if available or docker container
 */
class Studio {

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


        // start a new container
        const docker = await Studio.getDocker();
        // await docker.pull('jarvus/hologit-studio', {});

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
                    `DEBUG=${process.env.DEBUG}`
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

    /**
     * Run a command in the studio
     */
    async exec (...command) {
        const options = typeof command[command.length-1] == 'object'
            ? command.pop()
            : {};

        logger.debug('studio-exec:', ...command);

        const env = [];
        if (options.$env) {
            for (const key of Object.keys(options.$env)) {
                env.push(`${key}=${options.$env[key]}`);
            }
        }

        const exec = await this.container.exec({
            Cmd: command,
            AttachStdout: true,
            AttachStderr: true,
            Env: env
        });

        const execStream = await exec.start();

        return new Promise((resolve, reject) => {
            const output = [];
            const outputStream = new stream.PassThrough();

            outputStream.on('data', chunk => output.push(chunk.toString('utf8')));
            execStream.output.on('end', () => resolve(output.join('').trim()));

            this.container.modem.demuxStream(execStream.output, outputStream, process.stderr);
        })
    }

    async habExec (pkg, bin, ...args) {
        return this.exec('hab', 'pkg', 'exec', pkg, bin, ...args);
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
        return this.habExec('jarvus/hologit', 'git-holo', ...command);
    }

    async getPackage (query) {
        let packagePath = await this.exec('hab', 'pkg', 'path', query);

        if (!packagePath) {
            await this.exec('hab', 'pkg', 'install', query);
            packagePath = await this.exec('hab', 'pkg', 'path', query);
        }

        return packagePath ? packagePath.substr(10) : null;
    }
}

module.exports = Studio;
