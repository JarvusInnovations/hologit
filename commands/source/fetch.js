exports.command = 'fetch [name]';
exports.desc = 'Fetch the source named <name> or --all sources';
exports.builder = {
    all: {
        describe: 'Fetch all sources',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function fetch ({ name, all }) {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // check inputs
    if (!name && !all) {
        throw new Error('[name] or --all must be provided');
    }


    // get repo interface
    const repo = await Repo.getFromEnvironment({ working: true });


    // load workspace
    const workspace = await repo.getWorkspace();


    // get source(s)
    const sources = all ? (await workspace.getSources()).values() : [workspace.getSource(name)];


    // execute fetch
    for (const source of sources) {
        const originalHash = await source.getHead();
        await source.fetch();
        const hash = await source.getHead();
        const { url, ref } = await source.getCachedConfig();

        if (hash == originalHash) {
            logger.info(`${source.name}@${hash.substr(0, 8)} up-to-date`);
        } else {
            logger.info(`${source.name}@${originalHash.substr(0, 8)}..${hash.substr(0, 8)} fetched ${url}#${ref}`);
        }
    }
};
