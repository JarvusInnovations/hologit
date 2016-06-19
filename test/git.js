var test = require('ava'),
    fs = require('fs'),
    path = require('path'),
    tmp = require('tmp'),
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

test.cb('get git dir from environment', function(t) {
    Git.getGitDirFromEnvironment(function(error, gitDir) {
        if (error) {
            return t.end(error);
        }

        t.is(gitDir, repo1Dir);
        t.end();
    });
});

test.cb('get work tree from environment', function(t) {
    Git.getWorkTreeFromEnvironment(function(error, workTree) {
        if (error) {
            return t.end(error);
        }

        t.is(workTree, repo1Dir);
        t.end();
    });
});

var cwdGit = new Git();
var otherGit = new Git(repo2Dir);

test('instances have correct gitDir', function(t) {
    t.is(cwdGit.gitDir, null);
    t.is(otherGit.gitDir, repo2Dir);
});

test.cb('cwd git executes with correct git dir', function(t) {
    cwdGit.exec('rev-parse', { 'git-dir': true }, function(error, output) {
        if (error) {
            return t.end(error);
        }

        fs.realpath(output, function(error, gitDir) {
            if (error) {
                return t.end(error);
            }

            t.is(gitDir, repo1Dir);
            t.end();
        });
    });
});

test.cb('other git executes with correct git dir', function(t) {
    otherGit.exec('rev-parse', { 'git-dir': true }, function(error, output) {
        if (error) {
            return t.end(error);
        }

        fs.realpath(output, function(error, gitDir) {
            if (error) {
                return t.end(error);
            }

            t.is(gitDir, repo2Dir);
            t.end();
        });
    });
});

test.cb('other git executes with correct git dir with override', function(t) {
    otherGit.exec({ git: { 'git-dir': repo1Dir } }, 'rev-parse', { 'git-dir': true }, function(error, output) {
        if (error) {
            return t.end(error);
        }

        fs.realpath(output, function(error, gitDir) {
            if (error) {
                return t.end(error);
            }

            t.is(gitDir, repo1Dir);
            t.end();
        });
    });
});

test.cb('clone git repo to temporary directory', function(t) {
    tmp.dir(function(error, tmpWorkTree) {
        if (error) {
            return t.end(error);
        }

        tmp.tmpName(function(error, tmpIndexFile) {
            if (error) {
                return t.end(error);
            }

            cwdGit.exec(
                {
                    git: { 'work-tree': tmpWorkTree },
                    env: { GIT_INDEX_FILE: tmpIndexFile }
                },
                'checkout',
                { force: true },
                'HEAD',
                function(error, output) {
                    if (error) {
                        return t.end(error);
                    }

                    fs.stat(path.join(tmpWorkTree, 'README.md'), function(error, stats) {
                        if (error) {
                            return t.end(error);
                        }

                        t.truthy(stats);
                        t.true(stats.isFile());
                        t.end();
                    })
                }
            );
        });
    });
});