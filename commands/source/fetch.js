const logger = require('../../lib/logger.js');

exports.command = 'fetch <name>';
exports.desc = 'Fetch the source named <name>';
exports.builder = {
    all: {
        describe: 'COMING SOON: Check out working trees for all defined sources'
    }
};

exports.handler = async argv => {
    // execute command
    try {
        await fetch(argv);
        process.exit(0);
    } catch (err) {
        console.error('Command failed:', err);
        process.exit(1);
    }
};



async function fetch ({ name }) {
    const hololib = require('../../lib');


    // check inputs
    if (!name) {
        throw new Error('name required');
    }


    // load .holo info
    const repo = await hololib.getRepo();
    const source = await repo.getSource(name);


    // examine source
    const { url, ref } = source.config.holosource;
    const localRef = `refs/sources/${name}/${ref.substr(5)}`;


    // fetch current head first
    logger.info(`fetching head ${ref} ${source.head}`);
    await repo.git.fetch({ depth: 1 }, url, `+${source.head}:${localRef}`);


    // examine remote repo/branch
    logger.info(`listing ${url}#${ref}`);
    const lsRemoteOutput = await repo.git.lsRemote(url, ref);
    const match = lsRemoteOutput.match(/^([0-9a-f]{40})\t(\S+)$/m);

    if (!match) {
        throw new Error(`could not find remote ref for ${ref}`);
    }

    const hash = match[1];


    // fetch remote head
    if (hash != source.head) {
        logger.info(`fetching remote ${ref} ${hash}`);
        await repo.git.fetch({ depth: 1 }, url, `+${hash}:${localRef}`);
    }
}
