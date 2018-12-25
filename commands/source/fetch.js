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
    logger.debug('instantiated repository:', repo);


    // get source(s)
    const sources = all ? (await repo.getSources()).values() : [await repo.getSource(name)];


    // execute fetch
    for (const source of sources) {
        const hash = await source.fetch();
        const { url, ref } = await source.getCachedConfig();
        console.log(`fetched${all?` ${source.name}`:''} ${url}#${ref}@${hash}`);
    }
};
