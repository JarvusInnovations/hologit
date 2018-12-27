const Branch = require('./Branch.js');
const Workspace = require('./Workspace.js');


class Projection {

    constructor ({ branch }) {
        if (!branch || !(branch instanceof Branch)) {
            throw new Error('branch required, must be instance of Branch');
        }

        this.branch = branch;
        this.workspace = new Workspace({
            root: branch.getRepo().createTree()
        });

        Object.freeze(this);
    }

}

module.exports = Projection;
