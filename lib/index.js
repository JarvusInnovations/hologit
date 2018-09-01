const Repo = exports.Repo = require('./Repo.js');
const Source = exports.Source = require('./Source.js');

exports.getGit = getGit;
exports.getRepo = getRepo;
exports.getSource = getSource;
exports.initSource = initSource;

const treeLineRe = exports.treeLineRe = /^([^ ]+) ([^ ]+) ([^\t]+)\t(.*)/;


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
    const source = new Source();


    // load config
    if (name == repo.config.holo.name) {
        source.local = true;
    } else {
        const configPath = `.holo/sources/${name}.toml`;

        try {
            source.config = TOML.parse(await repo.git.catFile({ p: true }, `HEAD:${configPath}`));
        } catch (err) {
            throw new Error(`source ${name} is not defined`);
        }

        if (!source.config) {
            throw new Error(`failed to parse ${configPath}`);
        }

        if (
            !source.config.holosource
            || !source.config.holosource.url
            || !source.config.holosource.ref
        ) {
            throw new Error(`holosource config in ${configPath} is invalid`);
        }
    }


    // read HEAD
    try {
        source.head = await repo.git.revParse(source.local ? 'HEAD' : `HEAD:.holo/sources/${name}`);
    } catch (err) {
        source.head = null;
    }


    // load git interface
    if (source.local) {
        source.git = repo.git;
    } else {
        const workTree = `${repo.workTree}/.holo/sources/${name}`;

        if (await fs.exists(workTree)) {
            const gitDir = `${workTree}/.git`;

            if (await fs.exists(gitDir)) {
                source.git = new repo.git.Git({ gitDir, workTree });
            }
        }
    }


    // return info structure
    return source;
}

async function initSource (name) {
    const logger = require('./logger.js');
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
