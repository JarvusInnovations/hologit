var log = require('./log'),
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
Git.prototype.exec = function(execOptions, command, options, args, callback) {
    var execArgs = Array.prototype.slice.call(arguments),
        gitArgs = [];


    // parse variable arguments
    if (typeof execArgs[0] == 'object') {
        execOptions = execArgs.shift();
    } else {
        execOptions = {};
    }

    if (typeof execArgs[execArgs.length - 1] == 'function') {
        callback = execArgs.pop();
    } else {
        callback = null;
    }

    command = execArgs.shift();


    // sanity check
    if (typeof command != 'string') {
        throw 'command required';
    }


    // apply default execution options
    execOptions.git = execOptions.git || {};

    if (this.gitDir && !execOptions.git['git-dir']) {
        execOptions.git['git-dir'] = this.gitDir;
    }

    if (this.workTree && !execOptions.git['work-tree']) {
        execOptions.git['work-tree'] = this.workTree;
    }


    // git options must come first, before git command
    gitArgs.push.apply(gitArgs, cliOptionsToArgs(execOptions.git));


    // git command comes up next
    gitArgs.push(command);


    // append all remaining args
    while (execArgs.length) {
        args = execArgs.shift();

        switch (typeof args) {
            case 'number':
            case 'string':
                gitArgs.push(args.toString());
                break;
            case 'object':
                gitArgs.push.apply(gitArgs, Array.isArray(args) ? args : cliOptionsToArgs(args));
                break;
            default:
                throw 'unhandled execGit argument'
        }
    }

    log.debug('git', gitArgs.join(' '));

    if (execOptions.spawn) {
        if (typeof execOptions.spawn != 'object') {
            execOptions.spawn = {};
        }

        execOptions.spawn.shell = execOptions.shell;

        return child_process.spawn('git', gitArgs, execOptions.spawn);
    } else if(execOptions.shell) {
        return child_process.exec('git ' + gitArgs.join(' '), callback ? function (error, stdout, stderr) {
            gitArgs;
            callback(error, stdout.trim());
        } : null);
    } else {
        return child_process.execFile('git', gitArgs, callback ? function (error, stdout, stderr) {
            callback(error, stdout.trim());
        } : null);
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