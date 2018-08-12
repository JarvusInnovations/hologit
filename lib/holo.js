exports.getGit = getGit;
exports.getInfo = getInfo;

async function getGit () {
    return require('git-client').requireVersion('^2.8.0');
}

async function getInfo () {
    const git = await getGit();
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');

    // get git working tree
    const workTree = await git.constructor.getWorkTreeFromEnvironment();
    if (!workTree) {
        throw new Error('must run with a git working tree');
    }


    // .holo must exist
    const holoPath = `${workTree}/.holo`;

    if (!await fs.exists(holoPath)) {
        throw new Error(`${holoPath} does not exist`);
    }


    // .holo must be a directory
    const holoStat = await fs.stat(holoPath);

    if (!holoStat.isDirectory()) {
        throw new Error(`${holoPath} exists but is not a directory`);
    }


    // .holo/config must exist
    const configPath = `${holoPath}/config.toml`;

    if (!await fs.exists(configPath)) {
        throw new Error(`${configPath} does not exist`);
    }


    // read config
    const config = TOML.parse(await fs.readFile(configPath));

    if (!config) {
        throw new Error(`failed to parse ${configPath}`);
    }

    if (!config.holo || !config.holo.version) {
        throw new Error('.holo config invalid');
    }

    if (config.holo.version != 1) {
        throw new Error(`.holo version ${config.holo.version} unsupported`);
    }


    // return info structure
    return {
        gitDir: await git.constructor.getGitDirFromEnvironment(),
        workTree,
        holoPath,
        config
    };
}
