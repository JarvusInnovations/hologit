const logger = require('../../lib/logger.js');

exports.command = 'merge-trees <treeish-base> <treeish-input>';
exports.desc = 'Merge <treeish-input> into <treeish-base>';

exports.builder = {
    'treeish-base': {
        describe: 'Base tree',
        type: 'string'
    },
    'treeish-input': {
        describe: 'Input tree for merge',
        type: 'string'
    },
    'method': {
        describe: 'Merge method for applying input tree to base tree',
        default: 'overlay'
    }
};

exports.handler = async function mergeTrees ({ treeishBase, treeishInput, method }) {
    const hololib = require('../../lib');
    const git = await hololib.getGit();


    // TODO resolve tree ish if it doesn't look like a full hash


    // check inputs
    const baseTree = git.createTree({hash: treeishBase });
    const inputTree = git.createTree({hash: treeishInput });


    // apply merge
    if (method == 'overlay') {
        await baseTree.mergeOverlay(inputTree);
    } else {
        throw new Error('unhandled merge method: '+method);
    }


    // write tree
    console.log(await baseTree.write());
};
