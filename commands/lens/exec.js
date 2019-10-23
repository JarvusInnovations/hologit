exports.command = 'exec <spec-hash>';
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
    specHash,
    refresh=false,
    save=true
}) {
    const Lens = require('../../lib/Lens.js');

    const lensedTreeHash = await Lens.executeSpec(specHash, { refresh, save });

    if (lensedTreeHash) {
        console.log(lensedTreeHash);
        process.exit(0);
    } else {
        process.exit(1);
    }

};
