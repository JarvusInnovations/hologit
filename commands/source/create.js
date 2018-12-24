exports.command = 'create <url>';
exports.desc = 'Create a holosource for repo at url <url>';
exports.builder = {
    name: {
        describe: 'Name for the holosource'
    },
    ref: {
        describe: 'Name of ref to track in holosource repository',
        default: 'HEAD'
    }
};

exports.handler = async function createSource ({
    url,
    name = null,
    ref = null
}) {
    const path = require('path');
    const logger = require('../../lib/logger.js');
    const { Repo, Source } = require('../../lib');


    // check inputs
    if (!url) {
        throw new Error('url required');
    }


    // get repo interface
    const repo = await Repo.getFromEnvironment({ working: true });
    logger.debug('instantiated repository:', repo);


    // generate source name if not specified
    if (!name) {
        logger.debug('computing name from url:', url);
        const nameStack = url.split(path.sep);
        name = nameStack.pop();

        if (name == '.git') {
            name = nameStack.pop();
        } else if (name.substr(-4) == '.git') {
            name = name.substr(0, name.length - 4);
        }
    }


    // get source interface
    const source = repo.getSource(name);


    // read source config
    if (await source.readConfig()) {
        throw new Error('holosource already configured');
    }


    // get low-level git interface
    const git = await repo.getGit();


    // examine remote repo/branch to discover absolute ref and current commit hash
    logger.info(`listing ${url}#${ref}`);
    const lsRemoteOutput = await git.lsRemote({ symref: true }, url, ref);
    const match = lsRemoteOutput.match(/^(ref: (refs\/heads\/\S+)\tHEAD\n)?([0-9a-f]{40})\t(\S+)$/m);

    if (!match) {
        throw new Error(`could not find remote ref for ${ref}`);
    }

    const hash = match[3];
    const remoteRef = match[2] || match[4];


    // initialize source config
    const sourceConfig = {
        url,
        ref: remoteRef
    };


    // generate canonical source spec
    const spec = await Source.buildSpec(repo, sourceConfig);


    // fetch objects
    const localRef = `refs/holo/sources/${spec.hash}`;
    logger.info(`fetching ${url}#${remoteRef}@${hash}`);
    await git.fetch({ depth: 1 }, url, `+${hash}:${localRef}`);
    console.log(`fetched ${url}#${remoteRef}@${hash}`);


    // write config
    await source.writeConfig(sourceConfig);
    console.log(`initialized ${source.getConfigPath()}`);
};
