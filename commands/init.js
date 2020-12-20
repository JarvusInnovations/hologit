exports.command = 'init';
exports.desc = 'Initialize hologit for current repository';
exports.builder = {
    name: {
        describe: 'A canonical name for the current source branch used for self-references'
    }
};

exports.handler = async function init ({ name = null } = {}) {
    const logger = require('../lib/logger.js');
    const { Repo } = require('../lib');
    const path = require('path');


    // get repo interface
    const repo = await Repo.getFromEnvironment({ working: true });
    logger.debug('instantiated repository: %o', repo);


    // compute repo name
    if (!name) {
        if (repo.workTree) {
            logger.debug('computing name from work tree: %o', repo.workTree);
            name = path.basename(repo.workTree);
        } else {
            logger.debug('computing name from git dir: %o', repo.gitDir);
            const nameStack = repo.gitDir.split(path.sep);
            name = nameStack.pop();

            if (name == '.git') {
                name = nameStack.pop();
            } else if (name.substr(-4) == '.git') {
                name = name.substr(0, name.length - 4);
            }
        }
    }

    console.log(`name=${name}`);


    // read workspace config
    const workspace = await repo.getWorkspace();
    let repoConfig = await workspace.readConfig();
    logger.debug('loaded existing holorepo config: %o', repoConfig);


    // initialize repo config
    if (repoConfig) {
        if (repoConfig.name != name) {
            repoConfig.name = name;
            await workspace.writeConfig(repoConfig);
            console.log(`updated .holo/config.toml`);
        }
    } else {
        repoConfig = { name };
        await workspace.writeConfig(repoConfig);
        console.log(`initialized .holo/config.toml`);
    }


    // write changes to index
    await workspace.writeWorkingChanges();


    // return generated configuration
    return repoConfig;
};
