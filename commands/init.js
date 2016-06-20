var log = require('../lib/log'),
    Git = require('../lib/git'),
    async = require('async');


/**
 * Initialize a harmony branch
 * - [X] Check if branch exists already (die for now, merge on top of later)
 * - Load sources and mounts from topBranch
 * - Loop sources and generate commit for each
 * - Merge new commit onto virtualBranch
 */
module.exports = function(topBranch, virtualBranch, callback) {

    if (!topBranch) {
        log.error('topBranch required');
        process.exit(1);
    }

    if (!virtualBranch) {
        log.error('virtualBranch required');
        process.exit(1);
    }

    log.info('emergence-harmony-init', { topBranch: topBranch, virtualBranch: virtualBranch });

    var git = new Git();

    async.auto({
        getTopBranch: function(callback) {
            git.exec('show-ref', { s: true }, 'refs/heads/' + topBranch, function(error, sha) {
                callback(null, sha || null);
            });
        },
        getVirtualBranch: function(callback) {
            git.exec('show-ref', { s: true }, 'refs/heads/' + virtualBranch, function(error, sha) {
                callback(null, sha || null);
            });
        },
        getGitDir: function(callback) {
            git.exec('rev-parse', { 'git-dir': true }, callback);
        },
        getSomethingElse: [
            'getTopBranch',
            'getVirtualBranch',
            'getGitDir',
            function(results, callback) {
                var topBranchSha = results.getTopBranch,
                    virtualBranchSha = results.getVirtualBranch;

                if (!topBranchSha) {
                    return callback('branch ' + topBranch + ' not found');
                }

                if (virtualBranchSha) {
                    // TODO: allow and apply merge instead
                    return callback('branch ' + virtualBranch + ' already exists');
                }

                debugger;
                callback();
            }
        ]
    }, function(error, results) {
        if (error) {
            log.error(error);
            process.exit(1);
        }

        log.info('results', results);
        debugger;
    });
};

module.exports.usage = [
    'Usage: init topBranch virtualBranch'
];