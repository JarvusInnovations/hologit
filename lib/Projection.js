class Projection {

    constructor (branch) {
        this.branch = branch;
        this.repo = branch.repo;
        this.output = this.repo.createTree();

        Object.freeze(this);
    }

}

module.exports = Projection;
