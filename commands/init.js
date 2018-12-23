const logger = require('../lib/logger.js');

exports.command = 'init';
exports.desc = 'Initialize hologit for current repository';
exports.builder = {
    name: {
        describe: 'A canonical name for the current source branch used for self-references'
    }
};

exports.handler = async function init ({ name = null }) {
    const { Repo } = require('../lib');
    const path = require('path');


    // get holo repo from environment
    const repo = await Repo.getFromEnvironment({ working: true });


    // compute name
    if (!name) {
        if (repo.workTree) {
            name = path.basename(repo.workTree);
        } else {
            const nameStack = repo.gitDir.split(path.sep);
            name = nameStack.pop();

            if (name == '.git') {
                name = nameStack.pop();
            } else if (name.substr(-4) == '.git') {
                name = name.substr(0, name.length - 4);
            }
        }
    }


    // read config
    let config = await repo.readConfig();


    // initialize config
    if (config) {
        if (config.holo.name != name) {
            config.holo.name = name;
            await repo.writeConfig(config, true);
            console.log(`updated .holo/config.toml, changed name to ${name}`);
        }
    } else {
        config = {
            holo: { name }
        };
        await repo.writeConfig(config, true);
        console.log(`initialized .holo/config.toml for ${name}`);
    }
};
