exports.command = 'checkout [name]';
exports.desc = 'Check out submodule for source named <name> or --all sources';
exports.builder = {
    all: {
        describe: 'Check out submodules for all defined sources',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function checkoutSource ({ name, all }) {
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
        const result = await source.checkoutSubmodule();
        console.log(`checked out ${result.path} from ${result.url}#${result.branch||result.ref}@${result.head.substr(0, 8)}`);
    }

};
