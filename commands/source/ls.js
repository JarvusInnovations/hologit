exports.command = 'ls [name]';
exports.desc = 'List all configured sources';
exports.builder = {
    'name': {
        describe: 'Name for the holosource'
    },
    'fetch': {
        describe: 'True to fetch source(s)',
        type: 'boolean',
        default: false
    },
};

exports.handler = async function ls ({
    name,
    fetch,
}) {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // get repo interface
    const repo = await Repo.getFromEnvironment({ working: true });


    // load workspace
    const workspace = await repo.getWorkspace();


    // get source(s)
    const sources = name ? [workspace.getSource(name)] : [...(await workspace.getSources()).values()];


    // list sources
    const maxSourceLength = 
    Math.max(...sources.map(source => source.name.length));

    for (const source of sources) {
        const config = await source.getCachedConfig();
        const { url, ref } = config;

        let hash;
        if (fetch) {
            const originalHash = await source.getHead();
            await source.fetch();
            hash = await source.getHead();

            if (hash == originalHash) {
                logger.info(`${source.name}@${hash.substr(0, 8)} up-to-date`);
            } else {
                logger.info(`${source.name}@${originalHash.substr(0, 8)}..${hash.substr(0, 8)} fetched ${url}#${ref}`);
            }
        } else {
            hash = await source.getHead();
        }

        console.log(`${source.name}${' '.repeat(maxSourceLength-source.name.length)}\t${hash}\t${url}#${ref}`);
    }
};
