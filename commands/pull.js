module.exports = (cli) => cli
    .command('pull <virtual-branch>')
    .description('update a given virtual branch from its sources')
    .action(pull);


var logger = require('../lib/logger');


function pull(cmd, options) {
    logger.info('info from pull!');
    logger.debug('debug from pull!');
}