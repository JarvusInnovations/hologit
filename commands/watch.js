exports.command = 'watch';
exports.desc = 'Watch the current working tree and automatically update projection';

exports.builder = {
    'ref': {
        describe: 'Commit ref to watch',
        default: 'HEAD'
    },
    'working': {
        describe: 'Set to watch the (possibly uncommited) contents of the working tree',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function watch ({ ref = 'HEAD', working = false }) {
    const { Repo } = require('../lib');


    // load holorepo
    const repo = await Repo.getFromEnvironment({ ref, working });


    // and so our watch begins
    const { watching } = await repo.watch({
        callback: console.log
    });

    await watching;
};
