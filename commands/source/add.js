const logger = require('../../lib/logger.js');

exports.command = 'add <name> <url>';
exports.desc = 'Add a source named <name> for repo at url <url>';
exports.builder = {
    branch: {
        describe: 'Unique name for the source in the set of this repositories sources'
    }
};

exports.handler = async argv => {
    // execute command
    try {
        await addSource(argv);
        process.exit(0);
    } catch (err) {
        console.error('Command failed:', err);
        process.exit(1);
    }
};



async function addSource ({ name, url, branch }) {
    const hololib = require('../../lib/holo.js');
    const git = await hololib.getGit();
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // load .holo info
    const { holoPath } = await hololib.getInfo();


    // locate key paths
    const sourcesPath = `${holoPath}/sources`;
    const configPath = `${sourcesPath}/${name}.toml`;
    const repoPath = `${sourcesPath}/${name}`;


    // check that nothing conflicting already exists
    if (await fs.exists(configPath)) {
        throw new Error(`source config path already exists: ${configPath}`);
    }

    if (await fs.exists(repoPath)) {
        throw new Error(`source repository path already exists ${repoPath} already exists`);
    }


    // examine remote repo/branch
    logger.info(`listing ${url}#${branch}`);
    const lsRemoteOutput = await git.lsRemote({ symref: true }, url, branch || 'HEAD');
    const match = lsRemoteOutput.match(/^(ref: (refs\/heads\/\S+)\tHEAD\n)?([0-9a-f]{40})\t(\S+)$/m);

    if (!match) {
        throw new Error('could not find remote ref for '+(branch||'HEAD'));
    }

    const hash = match[3];
    const remoteRef = match[2] || match[4];
    const localRef = `refs/sources/${name}/${remoteRef.substr(5)}`;


    // fetch objects
    logger.info(`fetching ${remoteRef}`);
    await git.fetch({ depth: 1 }, url, `+${hash}:${localRef}`);


    // write config
    if (!await fs.exists(sourcesPath)) {
        logger.debug(`creating ${sourcesPath}`);
        await fs.mkdir(sourcesPath);
    }

    logger.debug(`writing ${configPath}`);
    await fs.writeFile(configPath, TOML.stringify({ holosource: { url, ref: remoteRef } }));

    logger.info(`added source ${name} at ${url}`);
}
