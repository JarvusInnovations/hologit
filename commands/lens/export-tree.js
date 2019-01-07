exports.command = 'export-tree <treeish>';
exports.desc = 'Export given <treeish> to current index and working tree (warning: destructive)';

exports.handler = async function exportTree ({ treeish }) {
    const { Repo } = require('../../lib');


    // load holorepo
    const repo = await Repo.getFromEnvironment({ working: true });
    const git = await repo.getGit();


    // check inputs
    if (!treeish) {
        throw new Error('treeish required');
    }

    if (!repo.workTree) {
        throw new Error('must be run in working tree');
    }


    // read tree contents into index
    await git.readTree(treeish);


    // write index contents to disk
    await git.checkoutIndex({ all: true, force: true });


    // delete anything on disk and not in index
    await git.clean({ d: true, force: true });
};
