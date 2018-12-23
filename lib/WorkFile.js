class WorkFile {

    constructor (path) {
        this.path = path;

        Object.freeze(this);
    }

}

module.exports = WorkFile;
