#!/usr/bin/env node

var flatiron = require('flatiron'),
    path = require('path'),
    app = flatiron.app;

// export app instance
module.exports = app;

// load environment into config
app.config.env();

// configure flatiron cli plugin
app.use(flatiron.plugins.cli, {
    source: path.join(__dirname, 'commands'),
    usage: 'Usage: init',
    argv: {
        debug: {
            alias: 'd',
            description: 'Show debug output',
            boolean: true
        }
    }
});

// start app
app.start({
    log: {
        level: app.argv.debug ? 'debug' : 'info'
    }
});