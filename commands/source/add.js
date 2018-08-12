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
    const fs = require('mz/fs');
    const TOML = require('@iarna/toml');


    // load .holo info
    const { git, holoDir } = await hololib.getRepo();


    // locate key paths
    const sourcesDir = `${holoDir}/sources`;
    const configFile = `${sourcesDir}/${name}.toml`;
    const workTree = `${sourcesDir}/${name}`;


    // check that nothing conflicting already exists
    if (await fs.exists(configFile)) {
        throw new Error(`source config path already exists: ${configFile}`);
    }

    if (await fs.exists(workTree)) {
        throw new Error(`${workTree} already exists`);
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
    logger.info(`fetching ${remoteRef} ${hash}`);
    await git.fetch({ depth: 1 }, url, `+${hash}:${localRef}`);


    // write config
    if (!await fs.exists(sourcesDir)) {
        logger.debug(`creating ${sourcesDir}`);
        await fs.mkdir(sourcesDir);
    }

    logger.info(`writing ${configFile}`);
    await fs.writeFile(configFile, TOML.stringify({ holosource: { url, ref: remoteRef } }));


    // initialize repository
    await hololib.initSource(name);


    // add to index
    logger.info(`staging source @ ${hash}`);
    await git.add(configFile);
    await git.updateIndex({ add: true, cacheinfo: true }, `160000,${hash},.holo/sources/${name}`);


    logger.info(`added source ${name} from ${url}`);
}
