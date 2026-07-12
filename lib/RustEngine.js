const logger = require('./logger');


/**
 * RustEngine — dispatcher for the hybrid Rust/JS projection pipeline
 * (specs/behaviors/engine-selection.md).
 *
 * Pure composition delegates to the holo-projector-napi binding when the
 * projection shape allows; anything else falls back to the JS engine with a
 * single logged line stating why. `HOLO_ENGINE=js|rust` forces either path —
 * `rust` turns every would-be fallback into a thrown error so CI can assert
 * the Rust path actually ran.
 *
 * The binding is loaded from the in-repo crate build (publication deferred);
 * when it isn't built, every dispatch degrades gracefully to the JS engine.
 */

// undefined = not probed yet, null = unavailable
let addon;
let addonLoadError = null;

function getAddon () {
    if (addon !== undefined) {
        return addon;
    }

    try {
        addon = require('../holo-projector-napi');
    } catch (err) {
        addon = null;
        addonLoadError = err;
        logger.debug('holo-projector addon not available, using JS engine: %s', err.message);
    }

    return addon;
}

function getEngineOverride () {
    const engine = process.env.HOLO_ENGINE || null;

    if (engine && engine != 'js' && engine != 'rust') {
        throw new Error(`invalid HOLO_ENGINE value "${engine}", expected "js" or "rust"`);
    }

    return engine;
}

/**
 * Evaluate the fallback conditions shared by both entry points. Returns a
 * reason string when the Rust path can't be used, or null when it can.
 */
function getFallbackReason ({ repo, fetch = false }) {
    if (fetch) {
        return 'fetch requested (fetching is a JS-owned side effect)';
    }

    if (repo.workTree) {
        return 'working tree mode (source heads may be hashed from checked-out worktrees)';
    }

    const sourceOverrides = Object.keys(process.env).filter(name => name.startsWith('HOLO_SOURCE_'));
    if (sourceOverrides.length) {
        return `HOLO_SOURCE_* environment overrides present (${sourceOverrides.join(', ')})`;
    }

    return null;
}

/**
 * Dispatch decision + fallback logging shared by both entry points. Returns
 * true when the Rust path should be attempted; throws under HOLO_ENGINE=rust
 * when it can't be.
 */
function shouldUseRust ({ what, repo, fetch, extraReason = null }) {
    const engine = getEngineOverride();

    if (engine == 'js') {
        logger.debug(`projecting ${what} with JS engine (HOLO_ENGINE=js)`);
        return false;
    }

    const reason = extraReason || getFallbackReason({ repo, fetch });
    if (reason) {
        if (engine == 'rust') {
            throw new Error(`HOLO_ENGINE=rust but the Rust engine cannot project ${what}: ${reason}`);
        }
        logger.info(`projecting ${what} with JS engine (rust engine fallback: ${reason})`);
        return false;
    }

    if (!getAddon()) {
        if (engine == 'rust') {
            throw new Error(`HOLO_ENGINE=rust but the holo-projector addon is not built: ${addonLoadError.message}\nrun: npm run build:projector-addon`);
        }
        // addon-not-built is the documented npm-consumer state, not an anomaly
        return false;
    }

    return true;
}

/**
 * Convert a binding error into a logged JS-engine fallback (returns null), or
 * rethrow under HOLO_ENGINE=rust.
 */
function handleBindingError (what, err) {
    if (getEngineOverride() == 'rust') {
        throw err;
    }

    logger.info(`projecting ${what} with JS engine (rust engine fallback: [${err.code}] ${err.message})`);
    return null;
}

class RustEngine {

    /**
     * Compose a holobranch to its pre-lens tree via the Rust engine.
     *
     * Returns the composed tree hash, or null when the caller should run the
     * JS composite path instead (with the reason already logged).
     */
    static async compositeBranch (branch, { fetch = false } = {}) {
        const workspace = branch.getWorkspace();
        const repo = branch.getRepo();
        const what = `holobranch ${branch.name}`;

        const extraReason =
            branch.phantom || branch.hasPhantomMappings ? 'programmatic (phantom) branch config'
            : workspace.hasPhantomSources ? 'programmatic (phantom) source config'
            : null;

        if (!shouldUseRust({ what, repo, fetch, extraReason })) {
            return null;
        }

        const rootHash = await workspace.root.write();

        try {
            const outputHash = getAddon().compositeBranch(repo.gitDir, rootHash, branch.name);
            logger.info(`composited tree for ${what} with rust engine: ${outputHash}`);
            return outputHash;
        } catch (err) {
            return handleBindingError(what, err);
        }
    }

    /**
     * Compose a ProjectionPlan's structured sources/mappings via the Rust
     * engine. Returns the composed tree hash, or null for JS fallback.
     */
    static async projectPlan (repo, sources, mappings, { fetch = false } = {}) {
        const what = 'projection plan';

        if (!shouldUseRust({ what, repo, fetch })) {
            return null;
        }

        const planSources = [];
        for (const [name, config] of sources) {
            planSources.push({
                name,
                url: config.url || undefined,
                ref: config.ref || undefined,
                projectHolobranch: (config.project && config.project.holobranch) || undefined
            });
        }

        const planMappings = mappings.map(({ sourceName, config }) => ({
            source: sourceName,
            files: config.files || undefined,
            root: config.root || undefined,
            output: config.output || undefined,
            layer: config.layer || undefined,
            after: config.after || undefined,
            before: config.before || undefined
        }));

        try {
            const outputHash = getAddon().projectPlan(repo.gitDir, planSources, planMappings);
            logger.info(`composited tree for ${what} with rust engine: ${outputHash}`);
            return outputHash;
        } catch (err) {
            return handleBindingError(what, err);
        }
    }
}


module.exports = RustEngine;
