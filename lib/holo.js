const Repo = exports.Repo = require('./Repo.js');
const Source = exports.Source = require('./Source.js');

exports.getGit = getGit;
exports.getRepo = getRepo;
exports.getSource = getSource;
exports.initSource = initSource;

async function getGit () {
    return require('git-client').requireVersion('^2.8.0');
}

async function getRepo () {
    const git = await getGit();
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // initialize repo info packet
    const repo = new Repo({
        git,
        gitDir: await git.constructor.getGitDirFromEnvironment(),
        workTree: await git.constructor.getWorkTreeFromEnvironment()
    });


    // get git working tree
    if (!repo.workTree) {
        throw new Error('must run with a git working tree');
    }


    // .holo must exist
    repo.holoDir = `${repo.workTree}/.holo`;

    if (!await fs.exists(repo.holoDir)) {
        throw new Error(`${repo.holoDir} does not exist`);
    }


    // .holo must be a directory
    const holoStat = await fs.stat(repo.holoDir);

    if (!holoStat.isDirectory()) {
        throw new Error(`${repo.holoDir} exists but is not a directory`);
    }


    // config.toml must exist
    repo.configFile = `${repo.holoDir}/config.toml`;

    if (!await fs.exists(repo.configFile)) {
        throw new Error(`${repo.configFile} does not exist`);
    }


    // read config
    repo.config = TOML.parse(await fs.readFile(repo.configFile));

    if (!repo.config) {
        throw new Error(`failed to parse ${repo.configFile}`);
    }

    if (
        !repo.config.holo
        || !repo.config.holo.version
    ) {
        throw new Error('.holo config invalid');
    }

    if (repo.config.holo.version != 1) {
        throw new Error(`.holo version ${repo.config.holo.version} unsupported`);
    }


    // return info structure
    return repo;
}

async function getSource (name, repo) {
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // get holo info if not provided
    if (!repo) {
        repo = await getRepo();
    }


    // initialize source info packet
    const sourcesDir = `${repo.workTree}/.holo/sources`;
    const source = new Source({
        configFile: `${sourcesDir}/${name}.toml`
    });



    // config file must exist
    if (!await fs.exists(source.configFile)) {
        throw new Error(`${source.configFile} does not exist`);
    }


    // read config
    source.config = TOML.parse(await fs.readFile(source.configFile));

    if (!source.config) {
        throw new Error(`failed to parse ${source.configFile}`);
    }

    if (
        !source.config.holosource
        || !source.config.holosource.url
        || !source.config.holosource.ref
    ) {
        throw new Error('holosource config invalid');
    }


    // read HEAD
    try {
        source.head = await repo.git.revParse(`HEAD:.holo/sources/${name}`);
    } catch (error) {
        source.head = null;
    }


    // check if work tree and git dir exist
    const workTree = `${sourcesDir}/${name}`;
    info.workTree = await fs.exists(workTree) ? workTree : null;


    // return info structure
    return source;
}

async function initSource (name) {
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
