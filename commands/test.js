const logger = require('../lib/logger.js');

exports.command = 'test <holo-branch>';
exports.desc = 'Update a given holo branch from its sources';
exports.builder = {
    'holo-branch': {
        describe: 'Developer username to authenticate with'
    }
};

exports.handler = async argv => {
    // execute command
    try {
        await test(argv);
        process.exit(0);
    } catch (err) {
        console.error('Failed to test:', err);
        process.exit(1);
    }
};



async function test (options) {
    logger.info('info from test!');
    logger.debug('debug from test!');
    logger.debug('command options', options);
}
