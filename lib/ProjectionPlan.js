const Workspace = require('./Workspace.js');
const Branch = require('./Branch.js');


/**
 * ProjectionPlan — fluent builder API for programmatic git tree composition.
 *
 * Composes git trees without .holo/ TOML files by constructing Workspace,
 * Branch, Source, and Mapping objects with inline config.
 *
 * Usage:
 *   const plan = new ProjectionPlan(repo);
 *   plan.addLayer('skeleton', { url: '...', ref: 'refs/heads/main' });
 *   plan.addLayer('product', { url: '...', ref: 'refs/heads/main' }, { after: ['skeleton'] });
 *   const treeHash = await plan.project();
 */
class ProjectionPlan {

    constructor (repo) {
        if (!repo) {
            throw new Error('repo required');
        }

        this.repo = repo;
        this._sources = new Map();
        this._mappings = [];
    }

    /**
     * Add a source to the plan.
     *
     * @param {string} name - Source name (referenced by mappings)
     * @param {object} config - Source configuration
     * @param {string} config.url - Git URL or local filesystem path
     * @param {string} config.ref - Git ref (e.g., 'refs/heads/main', 'refs/tags/v1.0')
     * @param {object} [config.project] - Optional { holobranch } for recursive projection
     * @returns {ProjectionPlan} this (for chaining)
     */
    addSource (name, config) {
        this._sources.set(name, config);
        return this;
    }

    /**
     * Add a mapping to the plan.
     *
     * @param {string} sourceName - Name of a previously added source
     * @param {object} [config] - Mapping configuration
     * @param {string[]} [config.files=['**']] - Glob patterns for files to include
     * @param {string} [config.root='.'] - Subtree of source to map from
     * @param {string} [config.output='.'] - Target path in output tree
     * @param {string} [config.layer] - Layer name for ordering (defaults to sourceName)
     * @param {string[]} [config.after] - Source/layer names this must come after
     * @param {string[]} [config.before] - Source/layer names this must come before
     * @returns {ProjectionPlan} this (for chaining)
     */
    addMapping (sourceName, config = {}) {
        this._mappings.push({
            sourceName,
            config: {
                holosource: sourceName,
                files: config.files || ['**'],
                root: config.root || '.',
                output: config.output || '.',
                layer: config.layer || sourceName,
                after: config.after || null,
                before: config.before || null
            }
        });
        return this;
    }

    /**
     * Add a source and its default mapping in one call.
     *
     * @param {string} name - Source name
     * @param {object} sourceConfig - Source configuration (url, ref, project?)
     * @param {object} [mappingConfig] - Mapping configuration (files?, root?, output?, after?, before?)
     * @returns {ProjectionPlan} this (for chaining)
     */
    addLayer (name, sourceConfig, mappingConfig = {}) {
        this.addSource(name, sourceConfig);
        this.addMapping(name, mappingConfig);
        return this;
    }

    /**
     * Compose all layers and return the git tree hash.
     *
     * @param {object} [options] - Projection options
     * @param {boolean} [options.lens=false] - Whether to apply lens transformations
     * @param {boolean} [options.fetch=false] - Whether to fetch remote sources
     * @returns {Promise<string>} Git tree hash of the composed output
     */
    async project (options = {}) {
        // Build mapping configs keyed for the branch constructor
        const mappingConfigs = {};
        for (const { sourceName, config } of this._mappings) {
            mappingConfigs[`_${sourceName}`] = config;
        }

        // Build source configs for the workspace constructor
        const sourceConfigs = {};
        for (const [name, config] of this._sources) {
            sourceConfigs[name] = config;
        }

        // Create workspace with phantom sources — needs a minimal root tree
        const rootTree = this.repo.createTree();
        await rootTree.writeChild('.holo/config.toml', '[holospace]\nname = "plan"\n');

        const workspace = new Workspace({
            root: rootTree,
            sources: sourceConfigs
        });

        // Create branch with phantom mappings
        const branch = new Branch({
            workspace,
            name: '_plan',
            phantom: {},
            mappings: mappingConfigs
        });

        // Project (lazy require to avoid circular dependency via index.js)
        const Projection = require('./Projection.js');
        return Projection.projectBranch(branch, {
            lens: false,
            ...options
        });
    }
}


module.exports = ProjectionPlan;
