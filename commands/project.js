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
 * - [X] Ensure sources have recipricol alternates
 * - [X] Move source repos to root .git/modules tree
 * - [X] register as submodule under .git/config
 * - [X] Create shallow for submodules
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
    const sortKeys = require('sort-keys');

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

        if (!holospec.files) {
            throw new Error(`holospec has no files defined ${specPath}`);
        }

        // parse holospec and apply defaults
        spec.files = typeof holospec.files == 'string' ? [holospec.files] : holospec.files;
        spec.holosource = holospec.holosource || specPath.replace(layerFromPathRe, '$3$4');
        spec.layer = holospec.layer || spec.holosource;
        spec.inputPrefix = holospec.root || '.';
        spec.outputPrefix = path.join(path.dirname(specPath), holospec.output || '.');

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
        logger.info(`merging ${spec.layer}:${spec.inputPrefix != '.' ? spec.inputPrefix+'/' : ''}{${spec.files}} -> /${spec.outputPrefix != '.' ? spec.outputPrefix+'/' : ''}`);

        // load source
        let source = sourcesCache[spec.holosource];

        if (!source) {
            source = sourcesCache[spec.holosource] = await repo.getSource(spec.holosource);
        }


        // load tree
        const sourceTree = await repo.git.TreeRoot.read(`${source.head}:${spec.inputPrefix == '.' ? '' : spec.inputPrefix}`);


        // build matchers
        const minimatchOptions = { dot: true };
        const matchers = spec.files.map(pattern => new minimatch.Minimatch(pattern, minimatchOptions));


        // process each blob entry in tree
        treeLoop: for (const sourcePath in sourceTree) {
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
            const sourceObject = sourceTree[sourcePath];
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
    const lenses = [];
    const lensesByName = {};
    const lensNameFromPathRe = /^([^\/]+)\.toml$/;

    for (const lensPath in lensTree) {
        const name = lensPath.replace(lensNameFromPathRe, '$1');
        const config = TOML.parse(await repo.git.catFile({ p: true },  lensTree[lensPath].hash));

        if (!config.hololens || !config.hololens.package) {
            throw new Error(`lens config missing hololens.package: ${lensPath}`);
        }

        if (!config.input || !config.input.files) {
            throw new Error(`lens config missing input.files: ${lensPath}`);
        }


        // parse and normalize lens config
        const hololens = config.hololens;
        hololens.package = hololens.package;
        hololens.command = hololens.command || 'lens-tree {{ input.hash }}';


        // parse and normalize input config
        const input = {};
        input.files = typeof config.input.files == 'string' ? [config.input.files] : config.input.files;
        input.root = config.input.root || '.';

        if (config.input.before) {
            input.before =
                typeof config.input.before == 'string'
                    ? [config.input.before]
                    : config.input.before;
        }

        if (config.input.after) {
            input.after =
                typeof config.input.after == 'string'
                    ? [config.input.after]
                    : config.input.after;
        }


        // parse and normalize output config
        const output = {};
        output.root = config.output && config.output.root || input.root;
        output.merge = config.output && config.output.merge || 'overlay';


        lenses.push(lensesByName[name] = { name, hololens, input, output });
    }


    // compile edges formed by before/after requirements
    const lensEdges = [];

    for (const lens of lenses) {
        if (lens.input.after) {
            for (const afterLens of lens.input.after) {
                lensEdges.push([lensesByName[afterLens], lens]);
            }
        }

        if (lens.input.before) {
            for (const beforeLens of lens.input.before) {
                lensEdges.push([lens, lensesByName[beforeLens]]);
            }
        }
    }


    // sort specs by before/after requirements
    const sortedLenses = toposort.array(lenses, lensEdges);


    // apply lenses
    let tree = outputTree;

    for (const lens of sortedLenses) {

        // build matchers
        const minimatchOptions = { dot: true };
        const matchers = lens.input.files.map(pattern => new minimatch.Minimatch(pattern, minimatchOptions));


        // build tree of matching files to input to lens
        const inputRoot = lens.input.root == '.' ? null : path.join(lens.input.root, '.') + '/'; // normalize path
        const inputRootLength = inputRoot && inputRoot.length;
        const inputTree = {};

        logger.info(`building input tree for lens ${lens.name} from ${inputRoot ? inputRoot : ''}{${lens.input.files}}`);

        treeLoop: for (const treePath in tree) {
            let inputPath = treePath;

            if (inputRoot) {
                if (treePath.startsWith(inputRoot)) {
                    inputPath = treePath.substr(inputRootLength);
                } else {
                    continue;
                }
            }

            // apply positive matchers--must match at least one
            let matched = false;

            for (const matcher of matchers) {
                if (matcher.match(inputPath)) {
                    matched = true;
                } else if (matcher.negate) {
                    continue treeLoop;
                }
            }

            if (!matched) {
                continue;
            }

            // add blob to output tree or lenses
            // const outputPath = spec.outputPrefix == '.' ? sourcePath : path.join(spec.outputPrefix, sourcePath);

            inputTree[inputPath] = tree[treePath];
        }

        logger.info('assembling tree...');
        const inputTreeRoot = repo.git.TreeRoot.buildTreeObject(inputTree);

        logger.info('writing tree...');
        const inputTreeHash = await repo.git.TreeObject.write(inputTreeRoot, repo.git);

        logger.info(`generated input tree: ${inputTreeHash}`);

        // TODO: resolve lens version

        const specToml = TOML.stringify({
            hololens: sortKeys(lens.hololens, { deep: true }),
            input: { tree: inputTreeHash }
        });

        const specHash = await repo.git.BlobObject.write(specToml, repo.git);

        logger.info(`generated lens spec hash: ${specHash}`);

        // TODO: check for existing build
        // TODO: pass through lens

        logger.info(`merging lens output to /${lens.output.root != '.' ? lens.output.root+'/' : ''}`);
        // TODO: apply to ${outputTree}
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
