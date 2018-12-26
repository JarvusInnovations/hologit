exports.command = 'create <name>';
exports.desc = 'Create a holobranch named <name>';
exports.builder = {
    template: {
        describe: 'Which generated starting point to use for the new holobranch',
        choices: ['passthrough', 'empty'],
        default: 'empty'
    }
};

exports.handler = async function createBranch ({ name, template }) {
    const logger = require('../../lib/logger.js');
    const { Repo } = require('../../lib');


    // get holo repo from environment
    const repo = await Repo.getFromEnvironment({ working: true });
    logger.debug('instantiated repository:', repo);


    // get branch interface
    const branch = repo.getBranch(name);


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
        case 'passthrough':
            const repoConfig = await repo.getConfig();

            mappingConfigs[`_${repoConfig.name}`] = {
                files: '**'
            };

            break;
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

    return Promise.all(promises);
};
