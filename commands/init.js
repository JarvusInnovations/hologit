module.exports = (cli) => cli
    .command('init <top-branch> <virtual-branch>')
    .description('initialize a new virtual branch based on given top branch')
    .action(init);


var logger = require('../lib/logger'),
    Git = require('../lib/git'),
    co = require('co');


/**
 * Initialize a holobranch
 * - [X] Check if branch exists already (die for now, merge on top of later)
 * - [ ] Try loading repo with js-git and loading a tree
 * - Load sources and mounts from topBranch
 * - Loop sources and generate commit for each
 * - Merge new commit onto virtualBranch
 */
function init(topBranch, virtualBranch, options) {

    co(function*() {

        if (!topBranch) {
            throw 'topBranch required';
        }

        if (!virtualBranch) {
            throw 'virtualBranch required';
        }

        logger.info('git-holobranch-init', { topBranch: topBranch, virtualBranch: virtualBranch });

        var git = new Git(),
            gitData = yield {
                dir: git.exec('rev-parse', { 'git-dir': true }),
                topBranch: git.exec('show-ref', { s: true }, 'refs/heads/' + topBranch, { $nullOnError: true }),
                virtualBranch: git.exec('show-ref', { s: true }, 'refs/heads/' + virtualBranch, { $nullOnError: true })
            };

        if (!gitData.topBranch) {
            throw 'branch ' + topBranch + ' not found';
        }

        if (gitData.virtualBranch) {
            // TODO: allow and apply merge instead
            throw 'branch ' + virtualBranch + ' already exists';
        }

        debugger;

    }).catch(function(error) {
        logger.error('command failed', error);
    });

}