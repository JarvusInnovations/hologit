const logger = require('../lib/logger.js');

exports.command = 'project <holobranch> [target-branch]';
exports.desc = 'Projects holobranch named <holobranch>, optionally writing result to [target-branch]';

exports.builder = {
    'target-branch': {
        describe: 'Target branch'
    }
}

exports.handler = async argv => {
    // execute command
    try {
        console.log(await project(argv));
        process.exit(0);
    } catch (err) {
        console.error('Command failed:', err);
        process.exit(1);
    }
};


/**
 * Initialize a holobranch
 * - [X] Check if branch exists already (die for now, merge on top of later)
 * - [X] Try loading repo with js-git and loading a tree
 * - Load sources and mounts from topBranch
 * - Loop sources and generate commit for each
 * - Merge new commit onto virtualBranch
 */
async function project ({ holobranch, targetBranch }) {
    const hololib = require('../lib/holo.js');
    const TOML = require('@iarna/toml');
    const toposort = require('toposort');
    const minimatch = require('minimatch');
    const path = require('path');

    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // load .holo info
    const { git, gitDir } = await hololib.getRepo();


    // read holobranch tree
    logger.info('reading holobranch spec tree...');
    let treeOutput;

    try {
        treeOutput = (await git.lsTree({ 'full-tree': true, r: true }, `HEAD:.holo/branches/${holobranch}`)).split('\n');
    } catch (err) {
        treeOutput = [];
    }

    const specs = [];
    const specsByLayer = {};
    const layerFromPathRe = /^(.*\/)?(([^\/]+)\/_|_?([^_\/][^\/]+))\.toml$/;

    for (const treeLine of treeOutput) {
        const matches = hololib.treeLineRe.exec(treeLine);
        const specPath = matches[4];
        const spec = {
            config: TOML.parse(await git.catFile({ p: true },  matches[3]))
        };
        const holospec = spec.config.holospec;

        if (!holospec) {
            throw new Error(`invalid holospec ${specPath}`);
        }

        if (!holospec.src) {
            throw new Error(`holospec has no src defined ${specPath}`);
        }

        // parse holospec and apply defaults
        spec.src = holospec.src;
        spec.holosource = holospec.holosource || specPath.replace(layerFromPathRe, '$3$4');
        spec.layer = holospec.layer || spec.holosource;
        spec.inputPrefix = holospec.cwd || '.';
        spec.outputPrefix = path.join(path.dirname(specPath), holospec.dest || '.');

        if (holospec.before) {
            spec.before = typeof holospec.before == 'string' ? [holospec.before] : holospec.before;
        }

        if (holospec.after) {
            spec.after = typeof holospec.after == 'string' ? [holospec.after] : holospec.after;
        }

        specs.push(spec);

        if (specsByLayer[spec.layer]) {
            specsByLayer[spec.layer].push(spec);
        } else {
            specsByLayer[spec.layer] = [spec];
        }
    }


    // compile edges formed by before/after requirements
    const specEdges = [];

    for (const spec of specs) {
        if (spec.after) {
            for (const layer of spec.after) {
                for (const afterSpec of specsByLayer[layer]) {
                    specEdges.push([afterSpec, spec]);
                }
            }
        }

        if (spec.before) {
            for (const layer of spec.before) {
                for (const beforeSpec of specsByLayer[layer]) {
                    specEdges.push([spec, beforeSpec]);
                }
            }
        }
    }


    // sort specs by before/after requirements
    const sortedSpecs = toposort.array(specs, specEdges);


    // composite output tree
    logger.info('compositing tree...');
    const outputTree = {};
    const sourcesCache = {};

    for (const spec of sortedSpecs) {
        logger.info(`merging ${spec.layer}:${spec.inputPrefix != '.' ? spec.inputPrefix+'/' : ''}${spec.src} -> /${spec.outputPrefix != '.' ? spec.outputPrefix+'/' : ''}`);

        // load source
        let source = sourcesCache[spec.holosource];

        if (!source) {
            source = sourcesCache[spec.holosource] = await hololib.getSource(spec.holosource);
        }


        // load tree
        const treeOutput = (await git.lsTree({ 'full-tree': true, r: true }, `${source.head}:${spec.inputPrefix == '.' ? '' : spec.inputPrefix}`)).split('\n');


        // load matches from tree
        const srcMatcher = new minimatch.Minimatch(spec.src, { dot: true });


        // process each blob entry in tree
        for (const treeLine of treeOutput) {
            const matches = hololib.treeLineRe.exec(treeLine);
            const blobPath = matches[4];

            // exclude .holo/**
            if (blobPath.substr(0, 5) == '.holo') {
                continue;
            }

            // apply src matcher
            if (srcMatcher.match(blobPath)) {
                outputTree[spec.outputPrefix == '.' ? blobPath : path.join(spec.outputPrefix, blobPath)] = new git.BlobObject(matches[3], matches[1]);
            }
        }
    }


    // assemble tree
    logger.info('assembling tree...');

    const rootTree = new git.TreeObject();

    for (const treePath of Object.keys(outputTree).sort()) {
        let pathParts = treePath.split('/');
        let parentNode = rootTree;
        let nodeName;

        while ((nodeName = pathParts.shift()) && pathParts.length > 0) {
            parentNode = parentNode[nodeName] || (parentNode[nodeName] = new git.TreeObject());
        }

        parentNode[nodeName] = outputTree[treePath];
    }


    // write tree
    logger.info('writing tree...');
    const rootTreeHash = await git.TreeObject.write(rootTree, git);


    // update targetBranch
    if (targetBranch) {
        logger.info(`committing new tree to "${targetBranch}"...`);

        const targetRef = `refs/heads/${targetBranch}`;
        const sourceDescription = await git.describe({ always: true, tags: true });

        let parentHash;
        try {
            parentHash = await git.revParse(targetRef);
        } catch (err) {
            parentHash = null;
        }

        const commitHash = await git.commitTree({ p: parentHash, m: `Projected ${holobranch} from ${sourceDescription}` }, rootTreeHash);

        await git.updateRef(targetRef, commitHash);
    }


    // finished
    logger.info('projection ready:');
    return rootTreeHash;
}
