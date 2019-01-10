exports.command = 'checkout [name]';
exports.desc = 'Check out repositories for source named <name> or --all sources';
exports.builder = {
    all: {
        describe: 'Check out repositories for all defined sources',
        type: 'boolean',
        default: false
    },
    submodule: {
        describe: 'Create a submodule for tracking the source\'s version in the outer repository',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function checkoutSource ({ name, all, submodule }) {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // check inputs
    if (!name && !all) {
        throw new Error('[name] or --all must be provided');
    }


    // get repo interface
    const repo = await Repo.getFromEnvironment({ working: true });


    // load workspace
    const workspace = await repo.getWorkspace();


    // get source(s)
    const sources = all ? (await workspace.getSources()).values() : [workspace.getSource(name)];


    // execute fetch
    for (const source of sources) {
        const result = await source.checkout({ submodule });
        console.log(`checked out ${result.path} from ${result.url}#${result.branch||result.ref}@${result.head.substr(0, 8)}`);
    }

};
