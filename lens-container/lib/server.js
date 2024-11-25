const http = require('http');
const { spawn } = require('child_process');
const Backend = require('git-http-backend');
const path = require('path');

/**
 * @typedef {Object} GitServerOptions
 * @property {number} [port=9000] Port to listen on
 * @property {string} repoDir Absolute path to git repository directory
 * @property {Function} [authenticate] Optional authentication function(req, res, next)
 */

/**
 * Creates and starts a basic HTTP server that handles Git HTTP requests
 *
 * @param {GitServerOptions} options Server configuration options
 * @returns {http.Server} The created HTTP server instance
 */
function createGitServer({ port = 9000, repoDir = null, authenticate }) {
    if (!repoDir) {
        throw new Error('repoDir option is required');
    }

    const server = http.createServer((req, res) => {
        // Handle CORS preflight requests
        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '86400'
            });
            res.end();
            return;
        }

        // Set CORS headers for all responses
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Handle authentication if provided
        if (typeof authenticate === 'function') {
            authenticate(req, res, () => handleGitRequest(req, res));
        } else {
            handleGitRequest(req, res);
        }
    });

    function handleGitRequest(req, res) {
        // Create git-http-backend instance
        const backend = new Backend(req.url, (err, service) => {
            if (err) {
                res.writeHead(500);
                res.end(err.toString());
                return;
            }

            res.setHeader('content-type', service.type);

            // Spawn git process with correct directory
            const ps = spawn(service.cmd, service.args, {
                cwd: repoDir
            });

            ps.stdout.pipe(service.createStream()).pipe(ps.stdin);
        });

        req.pipe(backend).pipe(res);
    }

    // Start the server
    server.listen(port, () => {
        console.log(`Git HTTP server listening on port ${port}`);
        console.log(`Serving git repository from: ${repoDir}`);
    });

    return server;
}

module.exports = createGitServer;
