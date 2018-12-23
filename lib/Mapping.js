const Configurable = require('./Configurable.js');


class Mapping extends Configurable {

    constructor ({ branch, key }) {
        super(...arguments);

        this.branch = branch;
        this.key = key;

        Object.freeze(this);
    }

    getKind () {
        return 'holomapping';
    }

    getConfigPath () {
        return `.holo/branches/${this.branch.name}/${this.key}.toml`;
    }

    getRepo () {
        return this.branch.repo;
    }

}

module.exports = Mapping;
