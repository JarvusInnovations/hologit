const core = require('@actions/core');
const cache = require('@actions/cache');


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {

    // save cache
    try {
        core.startGroup(`Saving package cache`);
        const cacheId = await cache.saveCache(['/hab/pkgs'], 'hab-pkgs');
        core.info(cacheId ? `Saved cache ${cacheId}` : 'No cache saved');
    } catch (err) {
        core.setFailed(`Failed to save package cache: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }

}
