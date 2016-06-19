var log = require('../lib/log'),
    Git = require('../lib/git');


/**
 * Initialize a harmony repository
 * - If local subrepo doesn't exist, move current repo there and initialize fresh repository with a commit of local merged into master with a tagged commit
 */
module.exports = function(callback) {
    log.info('emergence-harmony-init');

    var git = new Git();
    log.info('initialied git wrapper...', git);

    Git.getGitDirFromEnvironment(function(error, gitDir) {
        log.info('got git dir from env', {error: error, gitDir: gitDir});
    });

    Git.getWorkTreeFromEnvironment(function(error, workTree) {
        log.info('got work tree from env', {error: error, workTree: workTree});
    });

    callback();
};