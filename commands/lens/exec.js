exports.command = 'exec <spec-hash>';
exports.desc = 'Execute lens spec and output result hash';

exports.handler = async function exportTree ({ specHash }) {
    const Lens = require('../../lib/Lens.js');

    const lensedTreeHash = await Lens.executeSpec(specHash, { refresh: true });

    if (lensedTreeHash) {
        console.log(lensedTreeHash);
        process.exit(0);
    } else {
        process.exit(1);
    }

};
