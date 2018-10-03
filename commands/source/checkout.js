const logger = require('../../lib/logger.js');

exports.command = 'checkout <name>';
exports.desc = 'Check out working tree for a source';
exports.builder = {
    all: {
        describe: 'COMING SOON: Check out working trees for all defined sources'
    }
};

exports.handler = async function checkoutSource ({ name }) {
    const hololib = require('../../lib');
    const fs = require('mz/fs');


    // check inputs
    if (!name) {
        throw new Error('name required');
    }


    // load .holo info
    const repo = await hololib.getRepo();
    const source = await repo.getSource(name);


    // initialize repo if needed
    if (!source.git) {
        await source.init();
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


    // mark shallow if parent isn't reachable
    try {
        await source.git.catFile({ t: true }, 'HEAD^1');
    } catch (err) {
        logger.info(`marking source as shallow`);
        await fs.writeFile(`${await source.git.getGitDir()}/shallow`, source.head);
    }


    // configure submodule
    const sourcePath = `.holo/sources/${name}`;
    repo.git.config({ file: `${repo.workTree}/.gitmodules` }, `submodule.${sourcePath}.path`, sourcePath);
};
