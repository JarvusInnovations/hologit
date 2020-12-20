const core = require('@actions/core');


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {

    try {
        await require('habitat-action/post');
    } catch (err) {
        core.setFailed(`Failed to run habitat-action/cache: ${err.message}`);
        return;
    }
}
