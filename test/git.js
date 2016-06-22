var test = require('ava'),
    fs = require('mz/fs'),
    path = require('path'),
    tmp = require('tmp-promise'),
    rimraf = require('rimraf-promise'),
    Git = require('../lib/git'),

    fixtureDir = path.join(__dirname, 'fixture'),
    repo1Dir = path.join(fixtureDir, 'repo1'),
    repo2Dir = path.join(fixtureDir, 'repo2');

process.chdir(repo1Dir);

test('cwd is repo1 fixture', function(t) {
    t.is(process.cwd(), repo1Dir);
});

test('git module exports constructor and static methods', function(t) {
    t.is(typeof Git, 'function');
    t.is(typeof Git.getGitDirFromEnvironment, 'function');
    t.is(typeof Git.getWorkTreeFromEnvironment, 'function');
});

test('get git dir from environment', function(t) {
    return Git.getGitDirFromEnvironment().then(function(gitDir) {
        t.is(gitDir, repo1Dir);
    });
});

test('get work tree from environment', function(t) {
    return Git.getWorkTreeFromEnvironment().then(function(workTree) {
        t.is(workTree, null);
    });
});

var cwdGit = new Git();
var otherGit = new Git(repo2Dir);

test('instances have correct gitDir', function(t) {
    t.is(cwdGit.gitDir, null);
    t.is(otherGit.gitDir, repo2Dir);
});

test('cwd git executes with correct git dir', function(t) {
    return cwdGit.exec('rev-parse', { 'git-dir': true }).then(function(gitDir) {
        return fs.realpath(gitDir).then(function(realGitDir) {
            t.is(realGitDir, repo1Dir);
        });
    });
});

test('other git executes with correct git dir', function(t) {
    return otherGit.exec('rev-parse', { 'git-dir': true }).then(function(gitDir) {
        return fs.realpath(gitDir).then(function(realGitDir) {
            t.is(realGitDir, repo2Dir);
        });
    });
});

test('other git executes with correct git dir with override', function(t) {
    return otherGit.exec({ $gitDir: repo1Dir }, 'rev-parse', { 'git-dir': true }).then(function(gitDir) {
        return fs.realpath(gitDir).then(function(realGitDir) {
            t.is(realGitDir, repo1Dir);
        });
    });
});

test('checkout git repo to temporary directory', function(t) {

    return tmp.dir().then(function(tmpWorkTree) {

        return tmp.tmpName().then(function(tmpIndexFilePath) {

            return cwdGit.exec(
                { $workTree: tmpWorkTree.path, $indexFile: tmpIndexFilePath },
                'checkout', { force: true }, 'HEAD'
            ).then(function() {

                return fs.stat(path.join(tmpWorkTree.path, 'README.md')).then(function(stats) {

                    t.truthy(stats);
                    t.true(stats.isFile());

                    cwdGit.workTree = tmpWorkTree.path;

                    return cwdGit.exec('rev-parse', { 'show-toplevel': true }).then(function(effectiveWorkTree) {

                        return fs.realpath(effectiveWorkTree).then(function(realEffectiveWorkTree) {

                            return fs.realpath(tmpWorkTree.path).then(function(realTmpWorkTree) {
                                t.is(realEffectiveWorkTree, realTmpWorkTree);
                            });

                        });

                    });

                });
            });
        }).finally(function() {
            return rimraf(tmpWorkTree.path);
        });
    });

});