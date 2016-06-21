var logger = require('../lib/logger');

module.exports = (cli) => cli
    .command('pull <virtual-branch>')
    .description('update a given virtual branch from its sources')
    .action(function(cmd, options) {
        logger.info('info from pull!');
        logger.debug('debug from pull!');
    });