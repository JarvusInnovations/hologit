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

    // check inputs
    if (!holobranch) {
        throw new Error('holobranch required');
    }


    // load .holo info
    const { git, holoDir } = await hololib.getRepo();


    // read holobranch tree
    let treeOutput;

    try {
        treeOutput = (await git.lsTree({ r: true }, `HEAD:.holo/branches/${holobranch}`)).split('\n');
    } catch (err) {
        treeOutput = [];
    }


    // read holobranch tree
    const specs = [];
    const specsByLayer = {};
    const layerFromPathRe = /^(.*\/)?(([^\/]+)\/_|_?([^_\/][^\/]+))\.toml$/;

    for (const treeLine of treeOutput) {
        const matches = hololib.treeLineRe.exec(treeLine);
        const spec = {
            path: matches[4],
            hash: matches[3]
        };

        spec.config = TOML.parse(await git.catFile({ p: true }, spec.hash));
        const holospec = spec.config.holospec;

        if (!holospec) {
            throw new Error(`invalid holospec ${spec.path}`);
        }

        if (!holospec.src) {
            throw new Error(`holospec has no src defined ${spec.path}`);
        }

        // parse holospec and apply defaults
        spec.src = holospec.src;
        spec.holosource = holospec.holosource || spec.path.replace(layerFromPathRe, '$3$4');
        spec.layer = holospec.layer || spec.holosource;
        spec.cwd = holospec.cwd || '.';
        spec.dest = holospec.dest || '.';

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
