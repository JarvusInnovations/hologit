module.exports = (cli) => cli
    .command('project <source-branch> <holo-branch>')
    .description('projects a holo-branch based on given source-branch')
    .action(project);


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
function project(sourceBranch, holoBranch, options) {

    co(function*() {

        if (!sourceBranch) {
            throw 'sourceBranch required';
        }

        if (!holoBranch) {
            throw 'holoBranch required';
        }

        logger.info('git-holobranch-init', { sourceBranch: sourceBranch, holoBranch: holoBranch });

        var git = new Git(),
            gitData = yield {
                dir: git.exec('rev-parse', { 'git-dir': true }),
                sourceBranch: git.exec('show-ref', { s: true }, 'refs/heads/' + sourceBranch, { $nullOnError: true }),
                holoBranch: git.exec('show-ref', { s: true }, 'refs/heads/' + holoBranch, { $nullOnError: true })
            };

        if (!gitData.sourceBranch) {
            throw 'branch ' + sourceBranch + ' not found';
        }

        if (gitData.holoBranch) {
            // TODO: allow and apply merge instead
            throw 'branch ' + holoBranch + ' already exists';
        }

        debugger;

    }).catch(function(error) {
        logger.error('command failed', error);
    });

}