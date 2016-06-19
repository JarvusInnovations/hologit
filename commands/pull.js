var cli = require('../cli'),
    lib = require('../lib');

module.exports = function(callback) {
    console.log('Hello from pull!');
    console.log('lib.name =', lib.name);
    callback();
};