
class CommitObject {

    constructor (repo, { hash, mode }) {
        this.repo = repo;
        this.hash = hash;

        if (mode) {
            this.mode = mode;
        };

        Object.freeze(this);
    }
}

CommitObject.prototype.isCommit = true;
CommitObject.prototype.type = 'commit';
CommitObject.prototype.mode = '160000';

module.exports = CommitObject;
