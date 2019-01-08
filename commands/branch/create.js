exports.command = 'create <name>';
exports.desc = 'Create a holobranch named <name>';
exports.builder = {
    template: {
        describe: 'Which generated starting point to use for the new holobranch',
        choices: ['emergence-site', 'passthrough', 'empty'],
        default: 'empty'
    }
};

exports.handler = async function createBranch ({ name, template }) {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // check inputs
    if (!name) {
        throw new Error('name required');
    }


    // load holorepo
    const repo = await Repo.getFromEnvironment({ working: true });


    // load workspace
    const workspace = await repo.getWorkspace();


    // get branch interface
    const branch = workspace.getBranch(name);


    // read branch config
    if (await branch.readConfig()) {
        throw new Error('holobranch already configured');
    }


    // read mappings config
    if ((await branch.getMappings()).size) {
        throw new Error('holobranch already contains mappings');
    }


    // initialize branch config
    const branchConfig = {};
    const mappingConfigs = {};

    switch (template) {
        case 'empty':
            break;
        case 'passthrough': {
            const { name: workspaceName } = await workspace.getCachedConfig();

            mappingConfigs[`_${workspaceName}`] = {
                files: '**'
            };

            break;
        }
        case 'emergence-site': {
            const { name: workspaceName } = await workspace.getCachedConfig();

            mappingConfigs[`_${workspaceName}`] = {
                files: '*/**',
                after: ['skeleton-v2']
            };

            mappingConfigs[`_skeleton-v2`] = {
                files: '*/**'
            };

            break;
        }
        default:
            throw new Error(`unknown holobranch template: ${template}`);
    }

    const promises = [];

    if (Object.keys(branchConfig).length) {
        promises.push(branch.writeConfig(branchConfig));
        console.log(`initialized ${branch.getConfigPath()}`);
    }

    for (const key in mappingConfigs) {
        const mapping = branch.getMapping(key);
        promises.push(mapping.writeConfig(mappingConfigs[key]));
        console.log(`initialized ${mapping.getConfigPath()}`);
    }

    await Promise.all(promises);

    // write changes to index
    await workspace.writeWorkingChanges();
};
