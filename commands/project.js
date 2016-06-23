module.exports = (cli) => cli
    .command('project <source-branch> <holo-branch>')
    .description('projects a holo-branch based on given source-branch')
    .coHandler(project);


var logger = require('../lib/logger'),
    Git = require('../lib/git');


/**
 * Initialize a holobranch
 * - [X] Check if branch exists already (die for now, merge on top of later)
 * - [X] Try loading repo with js-git and loading a tree
 * - Load sources and mounts from topBranch
 * - Loop sources and generate commit for each
 * - Merge new commit onto virtualBranch
 */

function* project(sourceBranch, holoBranch, options) {

    if (!sourceBranch) {
        throw 'sourceBranch required';
    }

    if (!holoBranch) {
        throw 'holoBranch required';
    }

    logger.info('git-holobranch-init', { sourceBranch: sourceBranch, holoBranch: holoBranch });

    var git = new Git(),
        repo = yield git.getRepo(),
        refs = yield {
            sourceBranch: repo.readRef('refs/heads/' + sourceBranch),
            holoBranch: repo.readRef('refs/heads/' + holoBranch)
        };

    // check state of refs
    if (!refs.sourceBranch) {
        throw 'branch ' + sourceBranch + ' not found';
    }

    if (refs.holoBranch) {
        // TODO: allow and apply merge instead
        throw 'branch ' + holoBranch + ' already exists';
    }

    var sourceCommit = yield repo.loadAs('commit', refs.sourceBranch),
        sourceTree = yield repo.loadAs('tree', sourceCommit.tree);

    debugger;
}