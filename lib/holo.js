exports.getGit = getGit;
exports.getInfo = getInfo;
exports.initSourceRepo = initSourceRepo;

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

async function initSourceRepo (name) {
    const logger = require('./logger');
    const git = await getGit();
    const fs = require('mz/fs');


    // get git working tree
    const workTree = await git.constructor.getWorkTreeFromEnvironment();
    if (!workTree) {
        throw new Error('must run with a git working tree');
    }


    // initialize repository
    const repoPath = `${workTree}/.holo/sources/${name}`;
    logger.info(`initializing ${repoPath}`);
    await git.init(repoPath);


    // use main repo's objects database as alternate
    const alternatesConfigPath = `${repoPath}/.git/objects/info/alternates`;
    logger.info(`configuring ${alternatesConfigPath}`);
    await fs.writeFile(alternatesConfigPath, '../../../../../.git/objects');


    // return path of initialized repository
    return repoPath;
}
