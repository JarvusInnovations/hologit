exports.command = 'exec <spec>';
exports.desc = 'Execute lens spec and output result hash';
exports.builder = {
    refresh: {
        describe: 'True to execute lens even if existing result is available',
        type: 'boolean',
        default: false
    },
    save: {
        describe: 'False to disable updating spec ref with result',
        type: 'boolean',
        default: true
    }
};

exports.handler = async function exportTree ({
    spec: specHash,
    refresh=false,
    save=true
}) {
    const { Repo, SpecObject, Studio } = require('../../lib');
    const TOML = require('@iarna/toml');
    const handlebars = require('handlebars');
    const mkdirp = require('mz-modules/mkdirp');
    const shellParse = require('shell-quote-word');
    const squish = require('object-squish');


    // load holorepo
    const repo = await Repo.getFromEnvironment();
    const git = await repo.getGit();


    // check for existing build
    const specRef = SpecObject.buildRef('lens', specHash);
    const existingBuildHash = await repo.resolveRef(specRef);

    if (existingBuildHash) {
        console.log(existingBuildHash);
        return;
    }


    // load spec
    const specToml = await git.catFile({ p: true }, specHash);
    const {
        holospec: {
            lens: spec
        }
    } = TOML.parse(specToml);


    // assign scratch directory
    const scratchPath = `${process.env.HOLO_SCRATCH||'/hab/cache/hololens'}/${spec.package.split('/').slice(0, 2).join('/')}`;
    await mkdirp(scratchPath);


    // compile and execute command
    const hab = await Studio.getHab();
    const command = handlebars.compile(spec.command)(spec);

    const lensedTreeHash = await hab.pkg('exec', spec.package, ...shellParse(command), {
        $env: Object.assign(
            squish({
                hololens: { ...spec, spec: specHash }
            }, { seperator: '_', modifyKey: 'uppercase' }),
            {
                GIT_DIR: repo.gitDir,
                GIT_WORK_TREE: scratchPath,
                GIT_INDEX_FILE: `${scratchPath}.index`
            }
        )
    });

    debugger;

    if (!repo.git.isHash(lensedTreeHash)) {
        throw new Error(`lens "${command}" did not return hash: ${lensedTreeHash}`);
    }
};
