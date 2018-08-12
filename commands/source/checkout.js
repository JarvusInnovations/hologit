const logger = require('../../lib/logger.js');

exports.command = 'checkout <name>';
exports.desc = 'Checkout working tree for a source';

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
    const hololib = require('../../lib/holo.js');


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
    logger.info(await source.git.checkout(checkoutOptions, source.head));
}
