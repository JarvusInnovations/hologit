class Projection {

    constructor (branch) {
        this.branch = branch;
        this.repo = branch.repo;

        Object.freeze(this);
    }

}

module.exports = Projection;
