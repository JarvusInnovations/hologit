exports.command = 'ls';
exports.desc = 'List all configured sources';

exports.handler = async function ls () {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // get repo interface
    const repo = await Repo.getFromEnvironment({ working: true });


    // load workspace
    const workspace = await repo.getWorkspace();


    // get source(s)
    const sources = (await workspace.getSources()).values();


    // execute fetch
    for (const source of sources) {
        const config = await source.getCachedConfig();
        const hash = await source.getHead();
        const { url, ref } = config;

        console.log(`${source.name}@${hash.substr(0, 8)} ${url}#${ref}`);
    }
};
