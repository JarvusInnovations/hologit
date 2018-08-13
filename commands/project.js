const logger = require('../lib/logger.js');

exports.command = 'project <holobranch> [target-branch]';
exports.desc = 'Projects holobranch named <holobranch>, optionally writing result to [target-branch]';

exports.handler = async argv => {
    // execute command
    try {
        await project(argv);
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
    let treeOutput;

    try {
        treeOutput = (await git.lsTree({ 'full-tree': true, r: true }, `HEAD:.holo/branches/${holobranch}`)).split('\n');
    } catch (err) {
        treeOutput = [];
    }


    // read holobranch tree
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


    logger.info('sorted specs:\n', require('util').inspect(sortedSpecs, { showHidden: false, depth: null, colors: true }));


    const outputTree = {};
    const sources = {};

    for (const spec of sortedSpecs) {

        // load source
        let source = sources[spec.holosource];

        if (!source) {
            source = sources[spec.holosource] = await hololib.getSource(spec.holosource);
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


    logger.info('used sources:\n', require('util').inspect(sources, { showHidden: false, depth: null, colors: true }));

    // TODO: build outputTree into git tree using code from emergence-source-http-legacy


    /**
     * es-git does not yet work with packfiles :'(
     *
     * See https://github.com/es-git/es-git/issues/15
     */
    // const { mix } = esgit;
    // const Repo = mix(require('@es-git/node-fs-repo').default)
    //     .with(require('@es-git/zlib-mixin').default)
    //     .with(require('@es-git/object-mixin').default)
    //     .with(require('@es-git/load-as-mixin').default);

    // const repo = new Repo(gitDir);
    // const refs = await repo.listRefs();
    // const ref = await repo.getRef('refs/sources/skeleton-v2/heads/develop');
    // const blob = await repo.hasObject(ref);
    // const subtext = await repo.loadBlob(subtreeHash);
    // const subtree = await repo.loadTree(subtreeHash);





    // var repo = yield git.getRepo('js-git/mixins/create-tree'),
    //     refs = yield {
    //         sourceBranch: repo.readRef('refs/heads/' + sourceBranch),
    //         holoBranch: repo.readRef('refs/heads/' + holoBranch)
    //     };

    // // check state of refs
    // if (!refs.sourceBranch) {
    //     throw 'branch ' + sourceBranch + ' not found';
    // }

    // if (refs.holoBranch) {
    //     // TODO: allow and apply merge instead
    //     throw 'branch ' + holoBranch + ' already exists';
    // }

    // var sourceCommit = yield repo.loadAs('commit', refs.sourceBranch),
    //     sourceTree = yield repo.loadAs('tree', sourceCommit.tree);

    // var myTreeHash = yield repo.createTree({
    //     'php-classes': sourceTree['php-classes'],
    //     'php-config': sourceTree['php-config']
    // });

    // debugger;

    // var myTree = yield repo.loadAs('tree', myTreeHash[0]);

    // var myOtherTreeChanges = [
    //     {
    //         path: 'foo-classes',
    //         mode: sourceTree['php-classes'].mode,
    //         hash: sourceTree['php-classes'].hash
    //     },
    //     {
    //         path: 'foo-config',
    //         mode: sourceTree['php-config'].mode,
    //         hash: sourceTree['php-config'].hash
    //     }
    // ];

    // myOtherTreeChanges.base = myTreeHash[0];

    // var myOtherTreeHash = yield repo.createTree(myOtherTreeChanges);
    // var myOtherTree = yield repo.loadAs('tree', myOtherTreeHash[0]);

    // debugger;

    // // var treeStream = yield repo.treeWalk(sourceCommit.tree),
    // //     object;

    // // while (object = yield treeStream.read(), object !== undefined) {
    // //     console.log(object.hash + "\t" + object.path);
    // // }
}
