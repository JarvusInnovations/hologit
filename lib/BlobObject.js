
class BlobObject {

    static async write (repo, content) {
        debugger;
        const git = await repo.getGit();
        const hashObject = await git.hashObject({ w: true, stdin: true, $spawn: true });

        return new BlobObject(repo, {
            hash: await hashObject.captureOutputTrimmed(content)
        });
    }

    constructor (repo, { hash, mode = '100644' }) {
        this.repo = repo;
        this.hash = hash;
        this.mode = mode;

        Object.freeze(this);
    }

}

BlobObject.prototype.isBlob = true;

module.exports = BlobObject;
