const sortKeys = require('sort-keys');
const TOML = require('@iarna/toml');


const BlobObject = require('./BlobObject.js');


class SpecObject extends BlobObject {

    static async write (repo, kind, data) {
        const holospec = {};
        holospec[kind] = sortKeys(data, { deep: true });
        return super.write(repo, TOML.stringify({ holospec }));
    }

}


SpecObject.prototype.isSpec = true;
module.exports = SpecObject;
