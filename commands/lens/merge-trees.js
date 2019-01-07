exports.command = 'merge-trees <treeish-base> <treeish-input>';
exports.desc = 'Merge <treeish-input> into <treeish-base> and output resulting tree hash';

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
    const { Repo } = require('../../lib');


    // load holorepo
    const repo = await Repo.getFromEnvironment();
    const git = await repo.getGit();


    // check inputs
    const baseTree = await git.createTreeFromRef(treeishBase);
    const inputTree = await git.createTreeFromRef(treeishInput);


    // apply merge
    if (method == 'overlay') {
        await baseTree.merge(inputTree);
    } else {
        throw new Error('unhandled merge method: '+method);
    }


    // write tree
    const outputTree = await baseTree.write();
    console.log(outputTree);
    return outputTree;
};
