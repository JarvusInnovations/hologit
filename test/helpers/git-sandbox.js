/**
 * Git Sandbox Helper
 *
 * Creates isolated temporary git repositories for testing.
 * Each test can have its own clean git repo that won't affect
 * the real hologit repository.
 */

const os = require('os');
const path = require('path');
const fs = require('mz/fs');
const TOML = require('@iarna/toml');

class GitSandbox {
    constructor(dir, git) {
        this.dir = dir;
        this.gitDir = path.join(dir, '.git');
        this.git = git;
    }

    /**
     * Create a new isolated git repository for testing
     */
    static async create() {
        const Git = require('../../lib/Git.js');
        const gitClient = await Git.get();

        // Create temp directory
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hologit-test-'));

        // Initialize git repo
        const git = new gitClient.Git({
            gitDir: path.join(tmpDir, '.git'),
            workTree: tmpDir
        });

        await git.init();
        await git.config('user.email', 'test@hologit.test');
        await git.config('user.name', 'Hologit Test');

        // Create .git/holo directory (required by Repo)
        await fs.mkdir(path.join(tmpDir, '.git', 'holo'));

        return new GitSandbox(tmpDir, git);
    }

    /**
     * Add a file to the working tree
     */
    async addFile(filePath, content) {
        const fullPath = path.join(this.dir, filePath);
        const dir = path.dirname(fullPath);

        // Ensure directory exists
        await fs.mkdir(dir, { recursive: true });

        // Write file
        await fs.writeFile(fullPath, content);

        return fullPath;
    }

    /**
     * Stage and commit all changes
     */
    async commit(message) {
        await this.git.add({ all: true });
        const hash = await this.git.commit({ m: message, 'allow-empty': true });
        return hash;
    }

    /**
     * Initialize hologit configuration
     */
    async initHolo(config = {}) {
        const name = config.name || path.basename(this.dir);

        const tomlContent = TOML.stringify({
            holospace: { name }
        });

        await this.addFile('.holo/config.toml', tomlContent);

        return tomlContent;
    }

    /**
     * Add a holobranch configuration
     * @param {string} name - Branch name
     * @param {Object} mappings - Mapping configurations keyed by source name
     */
    async addBranch(name, mappings = {}, branchConfig = {}) {
        // Create branch config file if there are branch-level configs
        if (Object.keys(branchConfig).length > 0) {
            const branchToml = TOML.stringify({
                holobranch: branchConfig
            });
            await this.addFile(`.holo/branches/${name}.toml`, branchToml);
        }

        // Create mapping files for each source
        for (const [sourceName, mappingConfig] of Object.entries(mappings)) {
            const mapping = {
                holomapping: {
                    files: mappingConfig.files || '**',
                    ...mappingConfig
                }
            };

            // Remove 'files' from spread to avoid duplication
            delete mapping.holomapping.files;
            mapping.holomapping.files = mappingConfig.files || '**';

            const mappingToml = TOML.stringify(mapping);
            await this.addFile(`.holo/branches/${name}/${sourceName}.toml`, mappingToml);
        }
    }

    /**
     * Add a source configuration
     */
    async addSource(name, config = {}) {
        const sourceToml = TOML.stringify({
            holosource: config
        });

        await this.addFile(`.holo/sources/${name}.toml`, sourceToml);
    }

    /**
     * Get a Repo instance for this sandbox
     */
    async getRepo(options = {}) {
        const Repo = require('../../lib/Repo.js');

        // We can't use getFromEnvironment because it relies on process.cwd()
        // Instead, create a repo directly
        const repo = new Repo({
            gitDir: this.gitDir,
            ref: options.ref || 'HEAD',
            workTree: options.working ? this.dir : null
        });

        return repo;
    }

    /**
     * Get a Workspace instance for this sandbox
     */
    async getWorkspace(options = {}) {
        const repo = await this.getRepo(options);
        return repo.getWorkspace();
    }

    /**
     * Get the tree hash for a ref
     */
    async getTreeHash(ref = 'HEAD') {
        return this.git.getTreeHash(await this.git.revParse(ref));
    }

    /**
     * List files in a tree
     */
    async listTree(treeHash) {
        const output = await this.git.lsTree({ r: true, 'name-only': true }, treeHash);
        return output.split('\n').filter(Boolean);
    }

    /**
     * Read a file from a tree
     */
    async readFromTree(treeHash, filePath) {
        const blobHash = await this.git.revParse(`${treeHash}:${filePath}`);
        return this.git.catFile({ p: true }, blobHash);
    }

    /**
     * Clean up the sandbox (remove temp directory)
     */
    async cleanup() {
        // Use native fs.promises.rm for recursive removal
        const { rm } = require('fs').promises;
        await rm(this.dir, { recursive: true, force: true });
    }
}

module.exports = GitSandbox;
