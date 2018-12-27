
class BlobObject {

    static async write (repo, content) {
        const git = await repo.getGit();
        const hashObject = await git.hashObject({ w: true, stdin: true, $spawn: true });

        return new BlobObject(repo, {
            hash: await hashObject.captureOutputTrimmed(content)
        });
    }

    constructor (repo, { hash, mode }) {
        this.repo = repo;
        this.hash = hash;

        if (mode) {
            this.mode = mode;
        }

        Object.freeze(this);
    }

    async read () {
        const git = await this.repo.getGit();
        return git.catFile({ p: true }, this.hash);
    }
}

BlobObject.prototype.isBlob = true;
BlobObject.prototype.type = 'blob';
BlobObject.prototype.mode = '100644';

module.exports = BlobObject;
