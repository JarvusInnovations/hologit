const logger = require('../lib/logger.js');

exports.command = 'watch';
exports.desc = 'Watch the current working tree and automatically update projection';

exports.handler = async function watch (options) {
    const fs = require('mz/fs');
    const watchman = require('fb-watchman');
    const watchmanClient = new watchman.Client();

    logger.debug('Got watchman client', watchmanClient);

    // get watchman capabilities
    const capabilitiesResponse = await new Promise((resolve, reject) => {
        watchmanClient.capabilityCheck({ required: ['relative_root'] }, (err, response) => {
            if (err) {
                watchmanClient.end();
                reject(err);
            } else {
                resolve(response);
            }
        });
    });

    logger.debug('watchman capabilities', capabilitiesResponse);


    // initiate watch
    const watchRoot = await fs.realpath('./examples');
    const watchResponse = await new Promise((resolve, reject) => {
        watchmanClient.command(['watch-project', watchRoot], (err, response) => {
            if (err) {
                watchmanClient.end();
                reject(err);
            } else {
                if ('warning' in response) {
                    logger.warn(response.warning);
                }
                resolve(response);
            }
        });
    });

    logger.debug('watch established', watchResponse);


    // get current clock
    const clockResponse = await new Promise((resolve, reject) => {
        watchmanClient.command(['clock', watchResponse.watch], (err, response) => {
            if (err) {
                reject(err);
            } else {
                resolve(response);
            }
        });
    });


    // subscribe to changes
    const subscriptionConfig = {
        expression: ['allof', ['match', '*.js']],
        fields: ["name", "size", "mtime_ms", "exists", "type"],
        since: clockResponse.clock,
        relative_root: watchResponse.relative_path
    };

    logger.debug('subscriptionConfig', subscriptionConfig);

    const subscription = await new Promise((resolve, reject) => {
        watchmanClient.command(['subscribe', watchResponse.watch, 'mysubscription', subscriptionConfig], (err, response) => {
            if (err) {
                reject(err);
            } else {
                resolve(response);
            }
        });
    });

    logger.debug('subscription created', subscription);


    // print changes
    watchmanClient.on('subscription', response => {
        logger.debug('!subscription:', response.subscription);

        // TODO: stage files to an index? don't use since? or do and let git handle initial stage?
        for (const file of response.files) {
            logger.debug('file changed:', file.name, file.mtime_ms);
        }
    });


    // hang out until process gets killed
    return new Promise((resolve, reject) => {

    });
};
