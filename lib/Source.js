class Source {

    constructor (properties) {
        Object.assign(this, properties);
    }

    getBranch () {
        const branchMatch = this.config.holosource.ref.match(/^refs\/heads\/(\S+)$/);

        return branchMatch ? branchMatch[1] : null;
    }
}

module.exports = Source;
