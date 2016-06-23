module.exports = (cli) => cli
    .command('test <holo-branch>')
    .description('update a given holo branch from its sources')
    .coHandler(test);


var logger = require('../lib/logger');


function* test(cmd, options) {
    logger.info('info from test!');
    logger.debug('debug from test!');
}