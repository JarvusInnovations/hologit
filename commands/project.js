exports.command = 'project <holobranch>';
exports.desc = 'Projects holobranch named <holobranch> and outputs resulting tree hash';

exports.builder = {
    'commit-branch': {
        describe: 'A target branch to commit the projected tree to',
        type: 'string'
    },
    'commit-message': {
        describe: 'A commit message to use if commit-branch is specified',
        type: 'string'
    },
    'ref': {
        describe: 'Commit ref to read holobranch from',
        default: 'HEAD'
    },
    'working': {
        describe: 'Set to use the (possibly uncommited) contents of the working tree',
        type: 'boolean',
        default: false
    },
    'lens': {
        describe: 'Whether to apply lensing to the composite tree',
        type: 'boolean',
        default: true
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
exports.handler = async function project ({
    holobranch,
    ref = 'HEAD',
    lens = true,
    working = false,
    debug = false,
    commitBranch = null,
    commitMessage = null
}) {
    const hab = await require('hab-client').requireVersion('>=0.62');
    const logger = require('../lib/logger.js');
    const handlebars = require('handlebars');
    const { Repo, Projection } = require('../lib');
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


    // load holorepo
    const repo = await Repo.getFromEnvironment({ ref, working });


    // instantiate projection
    const projection = new Projection(repo.getBranch(holobranch));


    // read holobranch mappings
    logger.info('reading mappings from holobranch:', projection.branch);
    const mappings = await projection.branch.getMappings();


    // group mappings by layer
    const mappingsByLayer = {};
    for (const mapping of mappings.values()) {
        const { layer } = await mapping.getCachedConfig();

        if (mappingsByLayer[layer]) {
            mappingsByLayer[layer].push(mapping);
        } else {
            mappingsByLayer[layer] = [mapping];
        }
    }


    // compile edges formed by before/after requirements
    const mappingEdges = [];

    for (const mapping of mappings.values()) {
        const { after, before } = await mapping.getCachedConfig();

        if (after) {
            for (const layer of after) {
                for (const afterMapping of mappingsByLayer[layer]) {
                    mappingEdges.push([afterMapping, mapping]);
                }
            }
        }

        if (before) {
            for (const layer of before) {
                for (const beforeMapping of mappingsByLayer[layer]) {
                    mappingEdges.push([mapping, beforeMapping]);
                }
            }
        }
    }


    // sort specs by before/after requirements
    const sortedMappings = toposort.array(Array.from(mappings.values()), mappingEdges);


    // load git interface
    const git = await repo.getGit();


    // composite output tree
    logger.info('compositing tree...');
    for (const mapping of sortedMappings) {
        const { layer, root, files, output, holosource } = await mapping.getCachedConfig();

        logger.info(`merging ${layer}:${root != '.' ? root+'/' : ''}{${files}} -> /${output != '.' ? output+'/' : ''}`);

        // load source
        const source = await repo.getSource(holosource);
        const sourceHead = await source.getCachedHead();

        // load tree
        const sourceTree = await repo.createTreeFromRef(`${sourceHead}:${root == '.' ? '' : root}`);

        // merge source into target
        const targetTree = output == '.' ? projection.output : await projection.output.getSubtree(output, true);
        await targetTree.merge(sourceTree, {
            files: files
        });
    }


    // write and output pre-lensing hash if debug enabled
    if (debug) {
        logger.info('writing output tree before lensing...');
        const outputTreeHashBeforeLensing = await projection.output.write();
        logger.info('output tree before lensing:', outputTreeHashBeforeLensing);
    }


    if (lens) {
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

            // TODO: use a Configurable class to instantiate and load
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
        const scratchRoot = path.join('/hab/cache/holo', repo.gitDir.substr(1).replace(/\//g, '--'), projection.branch.name);

        for (const lens of sortedLenses) {

            // build tree of matching files to input to lens
            logger.info(`building input tree for lens ${lens.name} from ${lens.input.root == '.' ? '' : (path.join(lens.input.root, '.')+'/')}{${lens.input.files}}`);

            const lensInputTree = repo.git.createTree();
            const lensInputRoot = lens.input.root == '.' ? projection.output : await projection.output.getSubtree(lens.input.root);


            // merge input root into tree with any filters applied
            await lensInputTree.merge(lensInputRoot, {
                files: lens.input.files
            });

            const lensInputTreeHash = await lensInputTree.write();


            // execute lens via habitat
            let pkgPath;
            try {
                pkgPath = await hab.pkg('path', lens.hololens.package);
            } catch (err) {
                if (err.code != 1) {
                    throw err;
                }

                // try to install package
                logger.info('installing package for', lens.hololens.package);
                await hab.pkg('install', lens.hololens.package);
                pkgPath = await hab.pkg('path', lens.hololens.package);
            }


            // trim path to leave just fully-qualified ident
            lens.hololens.package = pkgPath.substr(10);


            // build and hash spec
            const spec = {
                hololens: sortKeys(lens.hololens, { deep: true }),
                input: lensInputTreeHash
            };
            const specToml = TOML.stringify(spec);
            const specHash = await repo.git.BlobObject.write(specToml, repo.git);
            const specRef = `refs/holo/specs/${specHash.substr(0, 2)}/${specHash.substr(2)}`;


            // check for existing output tree
            let lensedTreeHash = await repo.git.revParse(`${specRef}^{tree}`, { $nullOnError: true });


            // apply lens if existing tree not found
            if (lensedTreeHash) {
                logger.info(`found existing output tree matching holospec(${specHash})`);
            } else {
                // assign scratch directory for lens
                const scratchPath = `${scratchRoot}/${lens.name}`;
                await mkdirp(scratchPath);


                // compile and execute command
                const command = handlebars.compile(lens.hololens.command)(spec);
                logger.info('executing lens %s: %s', lens.hololens.package, command);
                lensedTreeHash = await hab.pkg('exec', lens.hololens.package, ...shellParse(command), {
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

                if (!repo.git.isHash(lensedTreeHash)) {
                    throw new Error(`lens "${command}" did not return hash: ${lensedTreeHash}`);
                }


                // save spec output
                await repo.git.updateRef(specRef, lensedTreeHash);
            }


            // apply lense output to main output tree
            logger.info(`merging lens output tree(${lensedTreeHash}) into /${lens.output.root != '.' ? lens.output.root+'/' : ''}`);

            const lensedTree = await repo.git.createTreeFromRef(lensedTreeHash);
            const lensTargetStack = await projection.output.getSubtree(lens.output.root, true, true);
            const lensTargetTree = lensTargetStack.pop();

            await lensTargetTree.merge(lensedTree, {
                mode: lens.output.merge
            });

            if (lensTargetTree !== projection.output && lensTargetTree.dirty) {
                // mark parents of lens target
                for (const parent of lensTargetStack) {
                    parent.dirty = true;
                }
            }
        }


        // strip .holo/ from output
        logger.info('stripping .holo/ tree from output tree...');
        projection.output.deleteChild('.holo');
    } else {
        const holoTree = await projection.output.getSubtree('.holo');

        for (const childName in await holoTree.getChildren()) {
            if (childName != 'lenses') {
                holoTree.deleteChild(childName);
            }
        }
    }


    // write tree
    logger.info('writing final output tree...');
    const rootTreeHash = await projection.output.write();


    // prepare output
    let outputHash = rootTreeHash;


    // update targetBranch
    if (commitBranch) {
        const targetRef = `refs/heads/${commitBranch}`;
        const parentHash = await git.revParse(targetRef, { $nullOnError: true });
        const commitHash = await git.commitTree(
            {
                p: parentHash,
                m: commitMessage || `Projected ${projection.branch.name} from ${await git.describe({ always: true, tags: true })}`
            },
            rootTreeHash
        );

        await git.updateRef(targetRef, commitHash);
        logger.info(`committed new tree to "${commitBranch}":`, commitHash);

        // change output to commit
        outputHash = commitHash;
    }


    // finished
    git.cleanup();

    logger.info('projection ready:');
    console.log(outputHash);
    return outputHash;
};
