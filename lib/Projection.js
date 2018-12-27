const Workspace = require('./Workspace.js');


class Projection {

    constructor ({ branch }) {
        if (!branch) {
            throw new Error('branch required');
        }

        this.branch = branch;
        this.workspace = new Workspace({
            root: branch.getRepo().createTree()
        });

        Object.freeze(this);
    }

}

module.exports = Projection;
