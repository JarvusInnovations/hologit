const Repo = exports.Repo = require('./Repo.js');
const Source = exports.Source = require('./Source.js');

exports.getGit = getGit;
exports.getRepo = getRepo;


async function getGit () {
    return require('git-client').requireVersion('^2.8.0');
}

const repos = {};

async function getRepo () {

    const git = await getGit();
    const gitDir = await git.constructor.getGitDirFromEnvironment();
    const workTree = await git.constructor.getWorkTreeFromEnvironment();


    // get git working tree
    if (!workTree) {
        throw new Error('must run with a git working tree');
    }


    // try to return existing instance first
    if (gitDir in repos && workTree in repos[gitDir]) {
        return repos[gitDir][workTree];
    }


    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // instantiate repo
    const repo = new Repo(git, { gitDir, workTree });


    // save instance to cache
    if (!(gitDir in repos)) {
        repos[gitDir] = {};
    }

    repos[gitDir][workTree] = git;


    // .holo must exist
    repo.holoDir = `${workTree}/.holo`;

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
