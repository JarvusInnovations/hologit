exports.Git = require('./Git.js');
exports.Repo = require('./Repo.js');
exports.Branch = require('./Branch.js');
exports.Source = require('./Source.js');
exports.Lens = require('./Lens.js');
exports.Workspace = require('./Workspace.js');
exports.Projection = require('./Projection.js');
exports.Studio = require('./Studio.js');

exports.BlobObject = require('./BlobObject.js');
exports.TreeObject = require('./TreeObject.js');
exports.SpecObject = require('./SpecObject.js');

exports.getGit = () => {
    require('./logger.js').warn('hololib.getGit() is deprecated, use Git.get() instead');
    return exports.Git.get();
};

exports.getRepo = () => {
    require('./logger.js').warn('hololib.getRepo() is deprecated, use Repo.getFromEnvironment() instead');
    return exports.Repo.getFromEnvironment();
};
