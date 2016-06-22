var logger = require('./logger'),
    fs = require('fs'),
    child_process = require('child_process');


/**
 * Constructor for git execution wrapper
 */
var Git = module.exports = function(options) {

    if (typeof options == 'string') {
        options = {
            gitDir: options
        };
    } else if (!options) {
        options = {};
    }

    this.gitDir = options.gitDir || null;
    this.workTree = options.workTree || null;
};


/**
 * Execute git command and return trimmed output
 */
Git.prototype.exec = function(command, options, args) {
    var execArgs = Array.prototype.slice.call(arguments),
        execOptions = {
            gitDir: this.gitDir,
            workTree: this.workTree
        },
        commandArgs = [],
        gitOptions = {}, gitArgs = [], gitEnv = {};


    // reset command, first arg might be an options object
    command = null;


    // scan through all arguments
    while (execArgs.length) {
        args = execArgs.shift();

        switch (typeof args) {
            case 'string':
                if (!command) {
                    command = args; // the first string is the command
                    break;
                }
                // fall through and get pushed with numbers
            case 'number':
                commandArgs.push(args.toString());
                break;
            case 'object':

                // extract any exec options
                if ('$gitDir' in args) {
                    execOptions.gitDir = args.$gitDir;
                    delete args.$gitDir;
                }

                if ('$workTree' in args) {
                    execOptions.workTree = args.$workTree;
                    delete args.$workTree;
                }

                if ('$nullOnError' in args) {
                    execOptions.nullOnError = args.$nullOnError;
                    delete args.$nullOnError;
                }

                if ('$env' in args) {
                    for (let key in args.$env) {
                        gitEnv[key] = args.$options[key];
                    }
                    delete args.$env;
                }

                if ('$indexFile' in args) {
                    gitEnv.GIT_INDEX_FILE = args.$indexFile;
                    delete args.$indexFile;
                }

                if ('$options' in args) {
                    for (let key in args.$options) {
                        execOptions[key] = args.$options[key];
                    }
                }

                // any remaiing elements are args/options
                commandArgs.push.apply(commandArgs, Array.isArray(args) ? args : cliOptionsToArgs(args));
                break;
            default:
                throw 'unhandled exec argument'
        }
    }


    // sanity check
    if (typeof command != 'string') {
        throw 'command required';
    }


    // apply git-level options
    if (execOptions.gitDir) {
        gitOptions['git-dir'] = execOptions.gitDir;
    }

    if (execOptions.workTree) {
        gitOptions['work-tree'] = execOptions.workTree;
    }

    execOptions.env = gitEnv;


    // compile git arguments
    gitArgs.push.apply(gitArgs, cliOptionsToArgs(gitOptions)); // git-level options come first
    gitArgs.push(command); // command name comes next
    gitArgs.push.apply(gitArgs, commandArgs);// command-level options come last


    // execute git command
    logger.debug('git', gitArgs.join(' '));

    if (execOptions.spawn) {
        return child_process.spawn('git', gitArgs, execOptions);
    } else if(execOptions.shell) {
        return function(done) {
            child_process.exec('git ' + gitArgs.join(' '), execOptions, function (error, stdout, stderr) {
                if (error) {
                    if (execOptions.nullOnError) {
                        error = null;
                    } else {
                        error.stderr = stderr;
                    }
                }

                done(error, stdout.trim());
            });
        };
    } else {
        return function(done) {
            child_process.execFile('git', gitArgs, execOptions, function (error, stdout, stderr) {
                if (error) {
                    if (execOptions.nullOnError) {
                        error = null;
                    } else {
                        error.stderr = stderr;
                    }
                }

                done(error, stdout.trim());
            });
        };
    }
};


/**
 * @private
 * Convert an options object into CLI arguments string
 */
function cliOptionsToArgs(options) {
    var args = [],
        k, val;

    for (k in options) {
        if (k[0] == '_') {
            continue;
        }

        val = options[k];

        if (k.length == 1) {
            if (val === true) {
                args.push('-'+k);
            } else if (val !== false) {
                args.push('-'+k, val);
            }
        } else {
            if (val === true) {
                args.push('--'+k);
            } else if (val !== false) {
                args.push('--'+k+'='+val);
            }
        }
    }

    return args;
}


/**
 * @static
 * Gets complete path to git directory
 */
Git.getGitDirFromEnvironment = function(callback) {
    Git.prototype.exec('rev-parse', { 'git-dir': true }, function(error, output) {
        if (error) {
            return callback(error);
        }

        fs.realpath(output, function(error, resolvedPath) {
            if (error) {
                return callback(error);
            }

            callback(null, resolvedPath);
        });
    });
};


/**
 * @static
 * Gets complete path to working tree
 */
Git.getWorkTreeFromEnvironment = function(callback) {
    Git.prototype.exec('rev-parse', { 'show-toplevel': true }, function(error, output) {
        if (error) {
            return callback(error);
        }

        fs.realpath(output, function(error, resolvedPath) {
            if (error) {
                return callback(error);
            }

            callback(null, resolvedPath);
        });
    });
};