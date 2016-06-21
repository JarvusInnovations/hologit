#!/usr/bin/env node

var path = require('path'),
    fs = require('fs'),

    logger = require('winston'),
    cli = require('commander'),

    commandsDir = path.join(__dirname, 'commands'),
    commandRe = /^[a-z][a-z\-]*[a-z]\.js$/;


// export CLI and logger
module.exports = {
    cli: cli,
    logger: logger
};


// configure commander CLI
cli
    .version(require('./package.json').version)
    .option('-d, --debug', 'enable debug output')
    .on('debug', function() {
        logger.level = 'debug';
    });


// load available commands
fs.readdir(commandsDir, function(error, files) {
    files.filter(fileName => commandRe.test(fileName)).forEach(fileName => {
        require(path.join(commandsDir, fileName))(cli);
    });


    // parse CLI arguments against loaded commands
    cli.parse(process.argv);
});