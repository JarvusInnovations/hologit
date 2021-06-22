const core = require('@actions/core');
const cache = require('@actions/cache');
const fs = require('fs');


const CACHE_KEY = 'habitat-action-pkgs';
const CACHE_LOCK_PATH = '/hab/cache/artifacts/.cached';


// gather input
const cacheKey = core.getInput('cache-key') || `hab-artifacts-cache:${process.env.GITHUB_WORKFLOW}`;


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {

    // save cache
    if (fs.existsSync(CACHE_LOCK_PATH)) {
        // .cached file is written at beginning of caching, and removed after restore to
        // guard against multiple post scripts trying to save the same cache
        core.info(`Skipping caching, ${CACHE_LOCK_PATH} already exists`);
    } else {
        try {
            core.startGroup(`Saving package cache`);

            core.info(`Writing cache lock: ${CACHE_LOCK_PATH}`);
            fs.writeFileSync(CACHE_LOCK_PATH, '');

            try {
                core.info(`Calling saveCache: ${cacheKey}`);
                const savedCache = await cache.saveCache(['/hab/cache/artifacts'], cacheKey);
                core.info(savedCache ? `Saved cache ${savedCache}` : 'No cache saved');
            } catch (err) {
                core.warning(`Failed to save cache: ${err.message}`);
            }
        } catch (err) {
            core.setFailed(`Failed to save package cache: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }
}
