class BlobFile {

    constructor ({ repo, hash, mode }) {
        this.repo = repo;
        this.hash = hash;
        this.mode = mode;

        Object.freeze(this);
    }

}

module.exports = BlobFile;
