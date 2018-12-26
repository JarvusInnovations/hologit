const sortKeys = require('sort-keys');
const TOML = require('@iarna/toml');


const BlobObject = require('./BlobObject.js');


class SpecObject extends BlobObject {

    static async write (repo, kind, data) {
        const holospec = {};
        holospec[kind] = sortKeys(data, { deep: true });
        const { hash } = await super.write(repo, TOML.stringify({ holospec }));
        return {
            hash,
            ref: `refs/holo/${kind}/${hash.substr(0, 2)}/${hash.substr(2)}`
        };
    }

}


SpecObject.prototype.isSpec = true;
module.exports = SpecObject;
