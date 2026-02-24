exports.command = 'inspect [holobranch]';
exports.desc = 'Display the fully resolved hologit configuration';

exports.builder = {
    'holobranch': {
        describe: 'Name of a specific holobranch to inspect'
    },
    'ref': {
        describe: 'Commit ref to read configuration from',
        default: 'HEAD'
    },
    'working': {
        describe: 'Use the (possibly uncommitted) contents of the working tree',
        type: 'boolean',
        default: false
    }
};

exports.handler = async function inspect ({
    holobranch,
    ref = 'HEAD',
    working = false
}) {
    const { Repo } = require('../lib');

    const repo = await Repo.getFromEnvironment({ ref, working });
    const workspace = await repo.getWorkspace();
    const { name: workspaceName } = await workspace.getCachedConfig();

    if (holobranch) {
        const branch = workspace.getBranch(holobranch);
        if (!await branch.isDefined()) {
            throw new Error(`holobranch not defined: ${holobranch}`);
        }
        await printBranch(workspace, workspaceName, branch, '');
    } else {
        await printWorkspace(workspace, workspaceName);
    }
};


async function printWorkspace (workspace, workspaceName) {
    console.log(`Workspace: ${workspaceName}`);

    // sources
    const sources = await workspace.getSources();
    if (sources.size) {
        console.log('\nSources:');
        for (const [name, source] of sources) {
            await printSource(source, '  ');
        }
    }

    // branches
    const branches = await workspace.getBranches();
    if (branches.size) {
        console.log('\nBranches:');
        for (const [name, branch] of branches) {
            if (await branch.isDefined()) {
                console.log('');
                await printBranch(workspace, workspaceName, branch, '  ');
            }
        }
    }
}


async function printBranch (workspace, workspaceName, branch, indent) {
    const config = await branch.getCachedConfig();
    const label = config.extend
        ? `${branch.name} (extends: ${config.extend})`
        : branch.name;
    console.log(`${indent}${label}`);

    // mappings
    const mappings = await branch.getMappings();
    if (mappings.size) {
        console.log(`${indent}  Mappings (${mappings.size}):`);
        for (const [key, mapping] of mappings) {
            await printMapping(workspace, workspaceName, mapping, `${indent}    `);
        }
    }

    // lenses
    const lenses = await branch.getLenses();
    if (lenses.size) {
        console.log(`${indent}  Lenses (${lenses.size}):`);
        for (const [name, lens] of lenses) {
            await printLens(lens, `${indent}    `);
        }
    }
}


async function printMapping (workspace, workspaceName, mapping, indent) {
    const config = await mapping.getCachedConfig();

    const isWorkspace = config.holosource === workspaceName;
    const sourceLabel = isWorkspace
        ? `${config.holosource} (workspace)`
        : config.holosource;

    console.log(`${indent}${mapping.key}`);
    console.log(`${indent}  source:  ${sourceLabel}`);
    console.log(`${indent}  files:   ${config.files.join(', ')}`);
    console.log(`${indent}  root:    ${config.root}`);
    console.log(`${indent}  output:  ${config.output}`);
    console.log(`${indent}  layer:   ${config.layer}`);

    if (config.after) {
        console.log(`${indent}  after:   ${config.after.join(', ')}`);
    }
    if (config.before) {
        console.log(`${indent}  before:  ${config.before.join(', ')}`);
    }
}


async function printLens (lens, indent) {
    const config = await lens.getCachedConfig();

    console.log(`${indent}${lens.name}`);

    if (config.container) {
        console.log(`${indent}  container: ${config.container}`);
    } else if (config.package) {
        console.log(`${indent}  package:   ${config.package}`);
    }

    const inputRoot = config.input.root === '.' ? '.' : config.input.root;
    const inputFiles = config.input.files.join(', ');
    console.log(`${indent}  input:     ${inputRoot}/{${inputFiles}}`);

    const outputRoot = config.output.root === '.' ? '.' : config.output.root;
    console.log(`${indent}  output:    ${outputRoot}/ (${config.output.merge})`);

    if (config.after) {
        console.log(`${indent}  after:     ${config.after.join(', ')}`);
    }
    if (config.before) {
        console.log(`${indent}  before:    ${config.before.join(', ')}`);
    }
}


async function printSource (source, indent) {
    const config = await source.getCachedConfig();

    if (config.$workspace) {
        console.log(`${indent}${source.name} (workspace)`);
    } else {
        const ref = config.ref || '';
        const url = config.url || '';
        console.log(`${indent}${source.name}`);
        console.log(`${indent}  url: ${url}`);
        console.log(`${indent}  ref: ${ref}`);

        if (config.project && config.project.holobranch) {
            console.log(`${indent}  project: ${config.project.holobranch}`);
        }
    }
}
