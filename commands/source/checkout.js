const logger = require('../../lib/logger.js');

exports.command = 'checkout <name>';
exports.desc = 'Check out working tree for a source';
exports.builder = {
    all: {
        describe: 'COMING SOON: Check out working trees for all defined sources'
    }
};

exports.handler = async argv => {
    // execute command
    try {
        await checkoutSource(argv);
        process.exit(0);
    } catch (err) {
        console.error('Command failed:', err);
        process.exit(1);
    }
};



async function checkoutSource ({ name }) {
    const hololib = require('../../lib');


    // check inputs
    if (!name) {
        throw new Error('name required');
    }


    // load .holo info
    const repo = await hololib.getRepo();
    const source = await hololib.getSource(name, repo);


    // initialize repo if needed
    if (!source.workTree) {
        source.workTree = await hololib.initSource(name);
    }


    // prepare checkout options
    const checkoutOptions = {};

    const branch = source.getBranch();
    if (branch) {
        checkoutOptions.B = branch;
    }

    // checkout HEAD
    logger.info(`checking out ${source.head}` + (branch ? ` to ${branch}` : ''));
    const checkoutOutput = await source.git.checkout(checkoutOptions, source.head);

    if (checkoutOutput) {
        logger.info(checkoutOutput);
    }
}
