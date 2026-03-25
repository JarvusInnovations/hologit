const TOML = require('@iarna/toml');


const BlobObject = require('./BlobObject.js');


class SpecObject extends BlobObject {

    static async write (repo, kind, data) {
        // build ordered spec object
        const holospec = {};
        holospec[kind] = deepSortKeys(data);

        // write canonical spec to a blob
        const { hash } = await super.write(repo, TOML.stringify({ holospec }));

        // write blob hash to a ref to enable fetching it and prevent garbage collection
        const git = await repo.getGit();
        await git.updateRef(`refs/holo/spec/${hash}`, hash);

        return {
            hash,
            ref: SpecObject.buildRef(kind, hash)
        };
    }

    static buildRef (kind, hash) {
        return `refs/holo/${kind}/${hash.substr(0, 2)}/${hash.substr(2)}`;
    }

}


SpecObject.prototype.isSpec = true;


function deepSortKeys (obj) {
    if (Array.isArray(obj)) return obj.map(deepSortKeys);
    if (obj === null || typeof obj !== 'object') return obj;

    return Object.keys(obj).sort().reduce((sorted, key) => {
        sorted[key] = deepSortKeys(obj[key]);
        return sorted;
    }, {});
}


module.exports = SpecObject;
