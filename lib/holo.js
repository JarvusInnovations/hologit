exports.getGit = getGit;
exports.getRepoInfo = getRepoInfo;
exports.getSourceInfo = getSourceInfo;
exports.initSourceRepo = initSourceRepo;

async function getGit () {
    return require('git-client').requireVersion('^2.8.0');
}

async function getRepoInfo () {
    const git = await getGit();
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // initialize repo info packet
    const info = {
        gitDir: await git.constructor.getGitDirFromEnvironment(),
        workTree: await git.constructor.getWorkTreeFromEnvironment()
    };


    // get git working tree
    if (!info.workTree) {
        throw new Error('must run with a git working tree');
    }


    // .holo must exist
    info.holoDir = `${info.workTree}/.holo`;

    if (!await fs.exists(info.holoDir)) {
        throw new Error(`${info.holoDir} does not exist`);
    }


    // .holo must be a directory
    const holoStat = await fs.stat(info.holoDir);

    if (!holoStat.isDirectory()) {
        throw new Error(`${holoDir} exists but is not a directory`);
    }


    // config.toml must exist
    info.configFile = `${info.holoDir}/config.toml`;

    if (!await fs.exists(info.configFile)) {
        throw new Error(`${info.configFile} does not exist`);
    }


    // read config
    info.config = TOML.parse(await fs.readFile(info.configFile));

    if (!info.config) {
        throw new Error(`failed to parse ${info.configFile}`);
    }

    if (
        !info.config.holo
        || !info.config.holo.version
    ) {
        throw new Error('.holo config invalid');
    }

    if (info.config.holo.version != 1) {
        throw new Error(`.holo version ${info.config.holo.version} unsupported`);
    }


    // return info structure
    return info;
}

async function getSourceInfo (name, repoInfo) {
    const git = await getGit();
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // get holo info if not provided
    if (!repoInfo) {
        repoInfo = await getRepoInfo();
    }


    // initialize source info packet
    const sourcesDir = `${repoInfo.workTree}/.holo/sources`;
    const info = {
        configFile: `${sourcesDir}/${name}.toml`
    };



    // config file must exist
    if (!await fs.exists(info.configFile)) {
        throw new Error(`${info.configFile} does not exist`);
    }


    // read config
    info.config = TOML.parse(await fs.readFile(info.configFile));

    if (!info.config) {
        throw new Error(`failed to parse ${info.configFile}`);
    }

    if (
        !info.config.holosource
        || !info.config.holosource.url
        || !info.config.holosource.ref
    ) {
        throw new Error('holosource config invalid');
    }


    // read HEAD
    try {
        info.head = await git.revParse(`HEAD:.holo/sources/${name}`);
    } catch (error) {
        info.head = null;
    }


    // check if work tree and git dir exist
    const workTree = `${sourcesDir}/${name}`;
    info.workTree = await fs.exists(workTree) ? workTree : null;


    // return info structure
    return info;
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
