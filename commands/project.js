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
exports.handler = async function project ({ holobranch, targetBranch, ref = 'HEAD', debug = false }) {
    const hab = await require('habitat-client').requireVersion('>=0.62');
    const handlebars = require('handlebars');
    const hololib = require('../lib');
    const mkdirp = require('mz-modules/mkdirp');
    const path = require('path');
    const shellParse = require('shell-quote-word');
    const sortKeys = require('sort-keys');
    const squish = require('object-squish');
    const TOML = require('@iarna/toml');
    const toposort = require('toposort');

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
        spec.root = path.join('.', holospec.root || '.', '.');
        spec.files = typeof holospec.files == 'string' ? [holospec.files] : holospec.files;
        spec.holosource = holospec.holosource || specPath.replace(layerFromPathRe, '$3$4');
        spec.layer = holospec.layer || spec.holosource;
        spec.output = path.join(path.dirname(specPath), holospec.output || '.', '.');

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
    const outputTree = repo.git.createTree();
    const sourcesCache = {};

    for (const spec of sortedSpecs) {
        logger.info(`merging ${spec.layer}:${spec.root != '.' ? spec.root+'/' : ''}{${spec.files}} -> /${spec.output != '.' ? spec.output+'/' : ''}`);

        // load source
        let source = sourcesCache[spec.holosource];

        if (!source) {
            source = sourcesCache[spec.holosource] = await repo.getSource(spec.holosource);
        }


        // load tree
        const sourceTree = await repo.git.createTreeFromRef(`${source.head}:${spec.root == '.' ? '' : spec.root}`);


        // merge source into target
        const targetTree = spec.output == '.' ? outputTree : await outputTree.getSubtree(spec.output, true);
        await targetTree.merge(sourceTree, {
            files: spec.files
        });
    }


    // write and output pre-lensing hash if debug enabled
    if (debug) {
        logger.debug('writing output tree before lensing...');
        const outputTreeHashBeforeLensing = await outputTree.write();
        logger.debug('output tree before lensing:', outputTreeHashBeforeLensing);
    }

    // read lens tree from output
    const lensFiles = {};
    const holoTree = await outputTree.getSubtree('.holo');

    if (holoTree) {
        const lensesTree = await holoTree.getSubtree('lenses');

        if (lensesTree) {
            const lensesTreeChildren = await lensesTree.getChildren();

            for (const lensName in lensesTreeChildren) {
                lensFiles[lensName] = lensesTreeChildren[lensName];
            }

            holoTree.deleteChild('lenses');
        }
    }


    // read lenses
    const lenses = [];
    const lensesByName = {};
    const lensNameFromPathRe = /^([^\/]+)\.toml$/;

    for (const lensPath in lensFiles) {
        const lensFile = lensFiles[lensPath];

        if (!lensFile || !lensFile.isBlob) {
            continue;
        }

        const name = lensPath.replace(lensNameFromPathRe, '$1');
        const config = TOML.parse(await repo.git.catFile({ p: true }, lensFile.hash));

        if (!config.hololens || !config.hololens.package) {
            throw new Error(`lens config missing hololens.package: ${lensPath}`);
        }

        if (!config.input || !config.input.files) {
            throw new Error(`lens config missing input.files: ${lensPath}`);
        }


        // parse and normalize lens config
        const hololens = config.hololens;
        hololens.package = hololens.package;
        hololens.command = hololens.command || 'lens-tree {{ input }}';


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
    const scratchRoot = path.join('/hab/cache/holo', repo.gitDir.substr(1).replace(/\//g, '--'), holobranch);

    for (const lens of sortedLenses) {

        // build tree of matching files to input to lens
        logger.info(`building input tree for lens ${lens.name} from ${lens.input.root == '.' ? '' : (path.join(lens.input.root, '.')+'/')}{${lens.input.files}}`);

        const lensInputTree = repo.git.createTree();
        const lensInputRoot = lens.input.root == '.' ? outputTree : await outputTree.getSubtree(lens.input.root);


        // merge input root into tree with any filters applied
        await lensInputTree.merge(lensInputRoot, {
            files: lens.input.files
        });


        logger.info('writing tree...');
        const lensInputTreeHash = await lensInputTree.write();

        logger.info(`generated input tree: ${lensInputTreeHash}`);


        // execute lens via habitat
        let pkgPath;
        try {
            pkgPath = await hab.pkg('path', lens.hololens.package);
        } catch (err) {
            if (err.code != 1) {
                throw err;
            }

            // try to install package
            await hab.pkg('install', lens.hololens.package);
            pkgPath = await hab.pkg('path', lens.hololens.package);
        }

        logger.info('resolved lens pkg: ', pkgPath);


        // trim path to leave just fully-qualified ident
        lens.hololens.package = pkgPath.substr(10);


        // build and hash spec
        const spec = {
            hololens: sortKeys(lens.hololens, { deep: true }),
            input: lensInputTreeHash
        };
        const specToml = TOML.stringify(spec);
        const specHash = await repo.git.BlobObject.write(specToml, repo.git);
        logger.info(`generated lens spec hash: ${specHash}`);


        // TODO: check for existing build


        // assign scratch directory for lens
        const scratchPath = `${scratchRoot}/${lens.name}`;
        await mkdirp(scratchPath);


        // compile and execute command
        const command = handlebars.compile(lens.hololens.command)(spec);
        const lensedTreeHash = await hab.pkg('exec', lens.hololens.package, ...shellParse(command), {
            $env: Object.assign(
                squish({
                    hololens: spec.hololens
                }, { seperator: '_', modifyKey: 'uppercase' }),
                {
                    HOLOSPEC: specHash,
                    GIT_DIR: repo.gitDir,
                    GIT_WORK_TREE: scratchPath,
                    GIT_INDEX_FILE: `${scratchPath}.index`
                }
            )
        });


        // apply lense output to main output tree
        logger.info(`merging lens output tree ${lensedTreeHash} into /${lens.output.root != '.' ? lens.output.root+'/' : ''}`);

        const lensedTree = await repo.git.createTreeFromRef(lensedTreeHash);
        const lensTargetTree = await outputTree.getSubtree(lens.output.root);

        await lensTargetTree.merge(lensedTree, {
            mode: lens.output.merge
        });
    }


    // strip .holo/ from output
    logger.info('stripping .holo/ tree from output tree...');
    outputTree.deleteChild('.holo');


    // write tree
    logger.info('writing final output tree...');
    const rootTreeHash = await outputTree.write();


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
    console.log(rootTreeHash);
    return rootTreeHash;
};
