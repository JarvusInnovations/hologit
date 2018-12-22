let git = null;

class Git {
    static async get () {
        return git || (git = await require('git-client').requireVersion('^2.8.0'));
    }
}

module.exports = Git;
