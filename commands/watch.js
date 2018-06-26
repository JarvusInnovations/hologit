const logger = require('../lib/logger.js');

exports.command = 'watch';
exports.desc = 'Watch the current working tree and automatically update projection';

exports.handler = async argv => {
    // execute command
    try {
        await watch(argv);
        process.exit(0);
    } catch (err) {
        console.error('Failed to watch:', err);
        process.exit(1);
    }
};



async function watch (options) {
    const watchman = require('fb-watchman');
    const watchmanClient = new watchman.Client();

    logger.debug('Got watchman client', watchmanClient);

    const capabilities = await new Promise((resolve, reject) => {
        watchmanClient.capabilityCheck(
            {
                optional: [],
                required: ['relative_root']
            },
            (err, response) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(response);
                }

            }
        );
    });

    logger.debug('watchman capabilities', capabilities);
}
