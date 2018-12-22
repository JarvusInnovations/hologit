exports.Git = require('./Git.js');
exports.Repo = require('./Repo.js');
exports.Source = require('./Source.js');

exports.getGit = () => {
    require('./logger.js').warn('hololib.getGit() is deprecated, use Git.get() instead');
    return exports.Git.get();
};

exports.getRepo = () => {
    require('./logger.js').warn('hololib.getRepo() is deprecated, use Repo.getFromEnvironment() instead');
    return exports.Repo.getFromEnvironment();
};
