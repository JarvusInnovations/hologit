var logger = require('../lib/logger'),
    Git = require('../lib/git'),
    async = require('async');


/**
 * Initialize a harmony branch
 * - [X] Check if branch exists already (die for now, merge on top of later)
 * - [ ] Try loading repo with js-git and loading a tree
 * - Load sources and mounts from topBranch
 * - Loop sources and generate commit for each
 * - Merge new commit onto virtualBranch
 */
module.exports = (cli) => cli
    .command('init <top-branch> <virtual-branch>')
    .description('initialize a new virtual branch based on given top branch')
    .action(function(topBranch, virtualBranch, options) {
        debugger;
        if (!topBranch) {
            logger.error('topBranch required');
            process.exit(1);
        }

        if (!virtualBranch) {
            logger.error('virtualBranch required');
            process.exit(1);
        }

        logger.info('emergence-harmony-init', { topBranch: topBranch, virtualBranch: virtualBranch });

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
                logger.error(error);
                process.exit(1);
            }

            logger.info('results', results);
            debugger;
        });
    });