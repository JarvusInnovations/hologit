exports.command = 'export-tree <treeish>';
exports.desc = 'Export given <treeish> to current index and working tree';

exports.handler = async function exportTree ({ treeish }) {
    const logger = require('../../lib/logger.js');
    const hololib = require('../../lib');


    // check inputs
    if (!treeish) {
        throw new Error('treeish required');
    }


    // load .holo info
    const git = await hololib.getGit();


    // read tree contents into index
    await git.readTree(treeish);


    // write index contents to disk
    await git.checkoutIndex({ all: true, force: true });


    // delete anything on disk and not in index
    await git.clean({ d: true, force: true });
};
