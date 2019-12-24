class ParentsBag
{
    constructor (value) {
        if (Array.isArray(value)) {
            this.sources = new Set(value);
        } else if (typeof value == 'string') {
            this.sources = new Set([value]);
        } else {
            this.sources = new Set;
        }

        this.commits = new Set;

        Object.freeze(this);
    }
}

module.exports = ParentsBag;