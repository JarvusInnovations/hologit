var logger = require('../lib/logger'),
    Git = require('../lib/git'),
    co = require('co');


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
    co(function*() {

        if (!topBranch) {
            throw 'topBranch required';
        }

        if (!virtualBranch) {
            throw 'virtualBranch required';
        }

        logger.info('emergence-harmony-init', { topBranch: topBranch, virtualBranch: virtualBranch });

        var git = new Git(),
            gitData = yield {
                dir: git.exec('rev-parse', { 'git-dir': true }),
                topBranch: git.exec({ errorOk: true }, 'show-ref', { s: true }, 'refs/heads/' + topBranch),
                virtualBranch: git.exec({ errorOk: true }, 'show-ref', { s: true }, 'refs/heads/' + virtualBranch)
            };

        if (!gitData.topBranch) {
            return callback('branch ' + topBranch + ' not found');
        }

        if (gitData.virtualBranch) {
            // TODO: allow and apply merge instead
            return callback('branch ' + virtualBranch + ' already exists');
        }

        debugger;

    }).catch(function(error) {
        logger.error('command failed', error);
    });

    });