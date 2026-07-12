const path = require('path');
const fs = require('fs').promises;

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
 * Rust-path work runs through a per-Repo ProjectionSession (a warm engine
 * context: persistent repository handle + TreeCache), so repeat projections
 * in one process — watch cycles above all — skip the ~100ms cold open
 * (specs/api/projector-napi.md § ProjectionSession).
 *
 * The binding is loaded from the in-repo crate build (publication deferred);
 * when it isn't built, every dispatch degrades gracefully to the JS engine.
 */

// undefined = not probed yet, null = unavailable
let addon;
let addonLoadError = null;

// warm engine context per Repo instance (host-owned, explicit lifecycle:
// lives exactly as long as the Repo object that projections run against)
const sessions = new WeakMap();

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
 * Whether any source sub-worktree is checked out under
 * `<workTree>/.holo/sources/` — the one working-tree condition the Rust
 * engine can't reproduce: the JS oracle hashes such checkouts into synthetic
 * source heads (filesystem state outside the object database). Without them,
 * source heads resolve from gitlinks and refs exactly as the Rust engine
 * does, so a working-tree projection whose root tree was already hashed is
 * tree-pure (specs/behaviors/engine-selection.md).
 */
async function hasSourceSubWorktrees (repo) {
    try {
        const entries = await fs.readdir(path.join(repo.workTree, '.holo', 'sources'), { withFileTypes: true });
        return entries.some(entry => entry.isDirectory());
    } catch (err) {
        if (err.code == 'ENOENT' || err.code == 'ENOTDIR') {
            return false;
        }
        throw err;
    }
}

/**
 * Evaluate the fallback conditions shared by both entry points. Returns a
 * reason string when the Rust path can't be used, or null when it can.
 */
async function getFallbackReason ({ repo, fetch = false }) {
    if (fetch) {
        return 'fetch requested (fetching is a JS-owned side effect)';
    }

    if (repo.workTree && await hasSourceSubWorktrees(repo)) {
        return 'checked-out source sub-worktree(s) present (filesystem state the Rust engine does not read)';
    }

    const sourceOverrides = Object.keys(process.env).filter(name => name.startsWith('HOLO_SOURCE_'));
    if (sourceOverrides.length) {
        return `HOLO_SOURCE_* environment overrides present (${sourceOverrides.join(', ')})`;
    }

    return null;
}

/**
 * The warm engine context bound to this Repo instance, created on first use
 * (specs/api/projector-napi.md § ProjectionSession). Callers must have
 * verified the addon is loadable via shouldUseRust()/getAddon() first.
 */
function getSession (repo) {
    let session = sessions.get(repo);
    if (!session) {
        session = new (getAddon().ProjectionSession)(repo.gitDir);
        sessions.set(repo, session);
    }
    return session;
}

/**
 * Dispatch decision + fallback logging shared by both entry points. Returns
 * true when the Rust path should be attempted; throws under HOLO_ENGINE=rust
 * when it can't be.
 */
async function shouldUseRust ({ what, repo, fetch, extraReason = null }) {
    const engine = getEngineOverride();

    if (engine == 'js') {
        logger.debug(`projecting ${what} with JS engine (HOLO_ENGINE=js)`);
        return false;
    }

    const reason = extraReason || await getFallbackReason({ repo, fetch });
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

        if (!await shouldUseRust({ what, repo, fetch, extraReason })) {
            return null;
        }

        const rootHash = await workspace.root.write();

        try {
            const outputHash = getSession(repo).compositeBranch(rootHash, branch.name);
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

        if (!await shouldUseRust({ what, repo, fetch })) {
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
            const outputHash = getSession(repo).projectPlan(planSources, planMappings);
            logger.info(`composited tree for ${what} with rust engine: ${outputHash}`);
            return outputHash;
        } catch (err) {
            return handleBindingError(what, err);
        }
    }

    /**
     * Create a projection commit via the Rust engine when commits are routed
     * there (specs/behaviors/engine-selection.md § Commit dispatch): only
     * under HOLO_ENGINE=rust — the JS engine remains the default committer
     * until the CI parity gate has proven commit-hash equality. Returns the
     * new commit hash, or null when JS owns the commit. The provenance
     * string is host-computed here, exactly as the oracle computes it
     * (specs/behaviors/projection-commits.md).
     */
    static async commitProjection (repo, { commitRef, holobranch, tree, sourceCommit = null, commitMessage = null }) {
        if (getEngineOverride() != 'rust') {
            return null;
        }

        if (!getAddon()) {
            throw new Error(`HOLO_ENGINE=rust but the holo-projector addon is not built: ${addonLoadError.message}\nrun: npm run build:projector-addon`);
        }

        const options = {
            commitRef,
            holobranch,
            tree,
            sourceCommit: sourceCommit || undefined,
            message: commitMessage || undefined
        };

        if (repo.workTree) {
            options.workTreePath = repo.workTree;
        } else {
            const git = await repo.getGit();
            options.sourceDescription = await git.describe({ always: true, tags: true }, repo.ref);
        }

        // no fallback handling: under HOLO_ENGINE=rust every failure —
        // REF_CONFLICT above all — must surface to the caller, never
        // degrade silently
        const commitHash = getSession(repo).commitProjection(options);
        logger.info(`committed projection ${holobranch} to ${commitRef} with rust engine: ${commitHash}`);
        return commitHash;
    }
}


module.exports = RustEngine;
