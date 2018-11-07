const logger = require('../../lib/logger.js');

exports.command = 'fetch <name>';
exports.desc = 'Fetch the source named <name>';
exports.builder = {
    all: {
        describe: 'COMING SOON: Check out working trees for all defined sources'
    }
};

exports.handler = async function fetch ({ name }) {
    const hololib = require('../../lib');


    // check inputs
    if (!name) {
        throw new Error('name required');
    }


    // load .holo info
    const repo = await hololib.getRepo();
    const source = await repo.getSource(name); // TODO: this does a fetch too...


    // execute fetch
    await source.fetch();
};
