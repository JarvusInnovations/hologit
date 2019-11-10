const path = require('path');
const Minimatch = require('minimatch').Minimatch;

const treeLineRe = /^([^ ]+) ([^ ]+) ([^\t]+)\t(.*)/;
const minimatchOptions = { dot: true };
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// use .changes map to track pending changes on top of cache, null value = delete
// children

const cache = {};

function cacheRead (hash) {
    if (hash == EMPTY_TREE_HASH) {
        return {};
    }

    return cache[hash] || null;
}

function cacheWrite (hash, children) {
    cache[hash] = children;
}


class MergeOptions {
    constructor ({ files = null, mode = 'overlay' }) {
        if (files && files.length && (files.length > 1 || files[0] != '**')) {
            this.matchers = files.map(pattern => typeof pattern == 'string' ? new Minimatch(pattern, minimatchOptions) : pattern);
        }

        if (mode != 'overlay' && mode != 'replace' && mode != 'underlay') {
            throw new Error(`unknown merge mode "${mode}"`);
        }

        this.mode = mode;
    }
}

class TreeObject {

    static getEmptyTreeHash () {
        return EMPTY_TREE_HASH;
    }

    static async createFromRef (repo, ref) {
        const git = await repo.getGit();

        try {
            const refHash = await git.revParse({ verify: true }, ref);
            const treeHash = await git.getTreeHash(refHash);
            return new TreeObject(repo, { hash: treeHash });
        } catch (err) {
            throw new Error(`invalid tree ref ${ref}: ${err}`);
        }
    }

    constructor (repo, { hash = EMPTY_TREE_HASH, parent = null } = {}) {
        this.repo = repo;
        this.dirty = false;
        this.hash = hash;
        this.parent = parent;
        this._children = {};
        this._baseChildren = null;

        Object.seal(this);
    }

    async getHash () {
        if (!this.dirty) {
            return this.hash;
        }

        return this.write();
    }

    getWrittenHash () {
        return !this.dirty && this.hash || null;
    }

    markDirty () {
        if (this.dirty) {
            return;
        }

        this.dirty = true;

        let parent = this.parent;
        while (parent) {
            parent.dirty = true;
            parent = parent.parent;
        }
    }

    async _loadBaseChildren (preloadChildren = false) {
        if (!this.hash || this.hash == EMPTY_TREE_HASH) {
            Object.setPrototypeOf(this._children, this._baseChildren = {});
            return;
        }

        if (this._baseChildren) {
            return;
        }

        const git = await this.repo.getGit();

        // read tree data from cache or filesystem
        let cachedHashChildren = cacheRead(this.hash);

        if (!cachedHashChildren) {
            cachedHashChildren = {};

            const treeLines = (await git.lsTree(preloadChildren ? { r: true, t: true, z: true } : { z: true }, this.hash)).split('\0');
            const preloadedTrees = {};

            for (const treeLine of treeLines) {
                if (!treeLine) {
                    continue;
                }

                const [, mode, type, hash, childPath] = treeLineRe.exec(treeLine);

                if (preloadChildren) {
                    const parentTreePathLength = childPath.lastIndexOf('/');

                    if (type == 'tree') {
                        // any tree listed will have children, begin cache entry
                        preloadedTrees[childPath] = {
                            hash,
                            children: {}
                        };
                    }

                    if (parentTreePathLength == -1) {
                        // direct child, add to current result
                        cachedHashChildren[childPath] = { type, hash, mode };
                    } else {
                        preloadedTrees[childPath.substr(0, parentTreePathLength)]
                            .children[childPath.substr(parentTreePathLength+1)] = { type, hash, mode };
                    }
                } else {
                    cachedHashChildren[childPath] = { type, hash, mode };
                }
            }

            cacheWrite(this.hash, cachedHashChildren);

            if (preloadChildren) {
                for (const treePath in preloadedTrees) {
                    const tree = preloadedTrees[treePath];
                    cacheWrite(tree.hash, tree.children);
                }
            }
        }


        // instantiate children
        const baseChildren = {};

        for (const name in cachedHashChildren) {
            const childCache = cachedHashChildren[name];
            switch (childCache.type) {
                case 'tree':
                    baseChildren[name] = this.repo.createTree({ ...childCache, parent: this });
                    break;
                case 'blob':
                    baseChildren[name] = this.repo.createBlob(childCache);
                    break;
                case 'commit':
                    baseChildren[name] = this.repo.createCommit(childCache);
                    break;
                default:
                    throw new Error(`unhandled tree child type: ${childCache.type}`);
            }
        }


        // save to instance and chain beneath children
        this._baseChildren = baseChildren;
        this._children = Object.setPrototypeOf(this._children || {}, baseChildren);
    }

    async getChild (childPath) {
        childPath = childPath.split('/');

        let cursor = this;
        while (childPath.length) {
            if (cursor.hash && !cursor._baseChildren) {
                await cursor._loadBaseChildren();
            }

            cursor = cursor._children[childPath.shift()];
            if (
                !cursor
                || (!cursor.isTree && childPath.length)
            ) {
                return null;
            }
        }

        return cursor;
    }

    async writeChild (childPath, content) {
        const tree = await this.getSubtree(path.dirname(childPath), true);

        if (typeof content == 'string') {
            content = await this.repo.writeBlob(content);
        }

        const childName = path.basename(childPath);
        const existingChild = tree._children[childName];

        if (
            existingChild
            && !existingChild.isTree
            && existingChild.hash == content.hash
        ) {
            return;
        }

        tree._children[childName] = content;
        tree.markDirty();

        return content;
    }

    async getChildren () {
        if (this.hash && !this._baseChildren) {
            await this._loadBaseChildren();
        }

        return this._children;
    }

    async getBlobMap () {
        if (this.hash && !this._baseChildren) {
            await this._loadBaseChildren(true);
        }

        // build map of blobs by path
        const children = this._children;
        const blobs = {};
        for (const name in children) {
            const child = children[name];

            if (child.isBlob) {
                blobs[`${name}`] = child;
            } else if (child.isTree) {
                const subBlobs = await child.getBlobMap();
                for (const subPath in subBlobs) {
                    blobs[`${name}/${subPath}`] = subBlobs[subPath];
                }
            }
        }

        return blobs;
    }

    deleteChild (childName) {
        if (this._children[childName] || !this._baseChildren) {
            this._children[childName] = null;
            this.markDirty();
        }
    }

    async getSubtree (subtreePath, create = false) {
        const stack = await this.getSubtreeStack(...arguments);
        return stack && stack[stack.length - 1] || null;
    }

    async getSubtreeStack (subtreePath, create = false) {
        if (subtreePath == '.') {
            return [this];
        }

        let tree = this,
            parents = [],
            subtreeName,
            nextTree;

        subtreePath = subtreePath.split(path.sep);

        while (tree && subtreePath.length) {
            subtreeName = subtreePath.shift();

            if (tree.hash && !tree._baseChildren) {
                await tree._loadBaseChildren();
            }

            parents.push(tree);
            nextTree = tree._children[subtreeName];

            if (!nextTree) {
                if (!create) {
                    return null;
                }

                nextTree = tree._children[subtreeName] = new TreeObject(this.repo, { parent: tree });
                for (const parent of parents) {
                    parent.dirty = true;
                }
            }

            tree = nextTree;
        }

        return [...parents, tree];
    }

    async write () {
        if (!this.dirty) {
            return this.hash;
        }

        if (this.hash && !this._baseChildren) {
            await this._loadBaseChildren();
        }


        // compile tree entry lines
        const children = this._children;
        const lines = [];
        for (const name in children) {
            const child = children[name];

            if (!child) {
                continue;
            }

            if (child.isTree) {
                if (child.dirty) {
                    await child.write();
                }

                if (child.hash == EMPTY_TREE_HASH) {
                    continue;
                }
            }

            lines.push({
                mode: child.mode || '100644',
                type: child.type,
                hash: child.hash,
                name
            });
        }


        // build tree hash
        if (lines.length == 0) {
            this.hash = EMPTY_TREE_HASH;
        } else {
            const git = await this.repo.getGit();
            this.hash = await git.mktreeBatch(lines);
        }


        // flush dirty state
        const baseChildren = this._baseChildren;
        for (const childName in children) {
            if (children.hasOwnProperty(childName)) {
                if (!(baseChildren[childName] = children[childName])) {
                    delete baseChildren[childName];
                }
                delete children[childName];
            }
        }
        this.dirty = false;


        return this.hash;
    }

    async merge (input, options = {}, basePath = '.', preloadChildren = true) {
        // load children of target and input
        if (this.hash && !this._baseChildren) {
            await this._loadBaseChildren(preloadChildren);
        }

        if (input.hash && !input._baseChildren) {
            await input._loadBaseChildren(preloadChildren);
        }


        // initialize options
        if (!(options instanceof MergeOptions)) {
            options = new MergeOptions(options);
        }


        // loop through input children
        const subMerges = [];
        const inputChildren = input._children;

        childrenLoop: for (const childName in inputChildren) {

            const inputChild = inputChildren[childName];

            // skip deleted node
            if (!inputChild) {
                continue;
            }


            let baseChild = this._children[childName];

            // skip if existing path matches
            if (
                baseChild
                && (!baseChild.dirty && !inputChild.dirty)
                && baseChild.hash == inputChild.hash
            ) {
                continue;
            }


            // test path
            const childPath = path.join(basePath, childName) + (inputChild.isTree ? '/' : '');
            let pendingChildMatch = false;

            if (options.matchers) {
                let matched = false;
                let negationsPossible = false;

                for (const matcher of options.matchers) {
                    if (matcher.match(childPath)) {
                        if (!matcher.negate) {
                            matched = true;
                        }
                    } else if (matcher.negate) {
                        continue childrenLoop;
                    }

                    if (matcher.negate) {
                        negationsPossible = true;
                    }
                }

                if (!matched && !inputChild.isTree) {
                    continue;
                }

                if ((!matched || negationsPossible) && inputChild.isTree) {
                    pendingChildMatch = true;
                }
            }


            // if input child is a blob, overwrite with copied ref
            if (!inputChild.isTree) {
                if (
                    !this._children[childName]
                    || options.mode == 'overlay'
                    || options.mode == 'replace'
                ) {
                    this._children[childName] = inputChild;
                    this.markDirty();
                }
                continue;
            }


            // if base child isn't a tree, create one
            let baseChildEmpty = false;

            if (!baseChild || !baseChild.isTree || options.mode == 'replace') {
                if (pendingChildMatch) {
                    // if file filters are in effect and this child tree has not been matched yet,
                    // finish merging its decendents into an empty tree and skip if it stays empty
                    baseChild = new TreeObject(this.repo, { parent: this });
                    await baseChild.merge(inputChild, options, childPath);

                    if (baseChild.dirty) {
                        this._children[childName] = baseChild;
                        this.markDirty();
                    }

                    continue;
                } else {
                    // if input child is clean, clone it and skip merge
                    if (!inputChild.dirty) {
                        this._children[childName] = new TreeObject(this.repo, { hash: inputChild.hash, parent: this });
                        this.markDirty();
                        continue;
                    }

                    // create an empty tree to merge input into
                    baseChild = this._children[childName] = new TreeObject(this.repo, { parent: this });
                    this.markDirty();
                    baseChildEmpty = true;
                }
            }


            // merge child trees
            const mergePromise = baseChild.merge(inputChild, options, childPath, !baseChildEmpty);

            if (!this.dirty) {
                mergePromise.then(() => {
                    if (baseChild.dirty) {
                        this.markDirty();
                    }
                });
            }


            // build array of promises for child tree merges
            subMerges.push(mergePromise);
        }


        // replace-mode should clear all unmatched existing children
        if (options.mode == 'replace') {
            for (const childName in this._children) {
                if (!inputChildren[childName]) {
                    this._children[childName] = null;
                }
            }
        }


        // return aggregate promise for child tree merges
        return Promise.all(subMerges);
    }
}

TreeObject.treeLineRe = treeLineRe;

TreeObject.prototype.isTree = true;
TreeObject.prototype.type = 'tree';
TreeObject.prototype.mode = '040000';

module.exports = TreeObject;
