#!/usr/bin/env node


// setup logger
const logger = require('winston');
module.exports = { logger };

if (process.env.DEBUG) {
    logger.level = 'debug';
}


// route command line
require('yargs')
    .version(require('../package.json').version)
    .option('d', {
        alias: 'debug',
        default: false,
        global: true
    })
    .option('q', {
        alias: 'quiet',
        default: false,
        global: true
    })
    .check(function(argv) {
        if (argv.debug) {
            logger.level = 'debug';
        } else if (argv.quiet) {
            logger.level = 'error';
        }

        return true;
    })
    .commandDir('../commands')
    .demandCommand()
    .strict()
    .help()
    .argv;
