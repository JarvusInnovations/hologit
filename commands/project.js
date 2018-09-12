const logger = require('../lib/logger.js');

exports.command = 'project <holobranch> [target-branch]';
exports.desc = 'Projects holobranch named <holobranch>, optionally writing result to [target-branch]';

exports.builder = {
    'target-branch': {
        describe: 'Target branch',
        type: 'string'
    },
    'ref': {
        describe: 'Commit ref to read holobranch from',
        default: 'HEAD'
    }
};

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
 * - [ ] Initialize and fetch sources automatically if needed
 * - [ ] Ensure sources have recipricol alternates
 * - [X] Move source repos to root .git/modules tree
 * - [X] register as submodule under .git/config
 * - [ ] Create shallow for submodules
 * - [ ] Load sources and mounts from topBranch
 * - [ ] Loop sources and generate commit for each
 * - [ ] Merge new commit onto virtualBranch
 */
async function project ({ holobranch, targetBranch, ref = 'HEAD' }) {
    const hololib = require('../lib');
    const TOML = require('@iarna/toml');
    const toposort = require('toposort');
    const minimatch = require('minimatch');
    const path = require('path');

    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // load .holo info
    const repo = await hololib.getRepo();


    // read holobranch tree
    logger.info(`reading holobranch spec tree from ${ref}`);
    const specTree = await repo.git.TreeRoot.read(`${ref}:.holo/branches/${holobranch}`, repo.git);

    const specs = [];
    const specsByLayer = {};
    const layerFromPathRe = /^(.*\/)?(([^\/]+)\/_|_?([^_\/][^\/]+))\.toml$/;

    for (const specPath in specTree) {
        const spec = {
            config: TOML.parse(await repo.git.catFile({ p: true },  specTree[specPath].hash))
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
    const lensTree = {};
    const sourcesCache = {};

    for (const spec of sortedSpecs) {
        logger.info(`merging ${spec.layer}:${spec.inputPrefix != '.' ? spec.inputPrefix+'/' : ''}${spec.src} -> /${spec.outputPrefix != '.' ? spec.outputPrefix+'/' : ''}`);

        // load source
        let source = sourcesCache[spec.holosource];

        if (!source) {
            source = sourcesCache[spec.holosource] = await repo.getSource(spec.holosource);
        }


        // load tree
        const sourceTree = await repo.git.TreeRoot.read(`${source.head}:${spec.inputPrefix == '.' ? '' : spec.inputPrefix}`);


        // build matchers
        const minimatchOptions = { dot: true };
        const matchers = [];

        for (const pattern of typeof spec.src == 'string' ? [spec.src] : spec.src) {
            matchers.push(new minimatch.Minimatch(pattern, minimatchOptions));
        }


        // process each blob entry in tree
        treeLoop: for (const sourcePath in sourceTree) {
            const sourceObject = sourceTree[sourcePath];

            // exclude .holo/**, except lenses
            if (sourcePath.substr(0, 6) == '.holo/' && sourcePath.substr(6, 7) != 'lenses/') {
                continue;
            }

            // apply positive matchers--must match at least one
            let matched = false;

            for (const matcher of matchers) {
                if (matcher.match(sourcePath)) {
                    matched = true;
                } else if (matcher.negate) {
                    continue treeLoop;
                }
            }

            if (!matched) {
                continue;
            }

            // add blob to output tree or lenses
            const outputPath = spec.outputPrefix == '.' ? sourcePath : path.join(spec.outputPrefix, sourcePath);

            if (outputPath.substr(0, 13) == '.holo/lenses/') {
                lensTree[outputPath.substr(13)] = sourceObject;
            } else {
                outputTree[outputPath] = new repo.git.BlobObject(sourceObject.hash, sourceObject.mode);
            }
        }
    }


    // assemble tree
    logger.info('assembling tree...');

    const rootTree = repo.git.TreeRoot.buildTreeObject(outputTree);


    // write tree
    logger.info('writing tree...');
    const rootTreeHash = await repo.git.TreeObject.write(rootTree, repo.git);


    // read lenses
    lensTree;
    for (const lensPath in lensTree) {
        const lens = {
            config: TOML.parse(await repo.git.catFile({ p: true },  lensTree[lensPath].hash))
        };
        const hololens = lens.config.hololens;

        if (!hololens) {
            throw new Error(`invalid hololens ${lensPath}`);
        }

        if (!hololens.src) {
            throw new Error(`hololens has no src defined ${lensPath}`);
        }

        debugger;

        // parse holospec and apply defaults
        // spec.src = holospec.src;
        // spec.holosource = holospec.holosource || lensPath.replace(layerFromPathRe, '$3$4');
        // spec.layer = holospec.layer || spec.holosource;
        // spec.inputPrefix = holospec.cwd || '.';
        // spec.outputPrefix = path.join(path.dirname(spelensPathcPath), holospec.dest || '.');

        // if (holospec.before) {
        //     spec.before = typeof holospec.before == 'string' ? [holospec.before] : holospec.before;
        // }

        // if (holospec.after) {
        //     spec.after = typeof holospec.after == 'string' ? [holospec.after] : holospec.after;
        // }

        // specs.push(spec);

        // if (specsByLayer[spec.layer]) {
        //     specsByLayer[spec.layer].push(spec);
        // } else {
        //     specsByLayer[spec.layer] = [spec];
        // }
    }


    // update targetBranch
    if (targetBranch) {
        logger.info(`committing new tree to "${targetBranch}"...`);

        const targetRef = `refs/heads/${targetBranch}`;
        const sourceDescription = await repo.git.describe({ always: true, tags: true });

        let parentHash;
        try {
            parentHash = await repo.git.revParse(targetRef);
        } catch (err) {
            parentHash = null;
        }

        const commitHash = await repo.git.commitTree({ p: parentHash, m: `Projected ${holobranch} from ${sourceDescription}` }, rootTreeHash);

        await repo.git.updateRef(targetRef, commitHash);
    }


    // finished
    logger.info('projection ready:');
    return rootTreeHash;
}
