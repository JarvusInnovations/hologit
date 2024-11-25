const http = require('http');
const { spawn } = require('child_process');
const Backend = require('git-http-backend');
const path = require('path');
const zlib = require('zlib');

/**
 * @typedef {Object} GitServerOptions
 * @property {number} [port=9000] Port to listen on
 * @property {string} gitDir Absolute path to git repository directory
 * @property {Function} [authenticate] Optional authentication function(req, res, next)
 */

/**
 * Creates and starts a basic HTTP server that handles Git HTTP requests
 *
 * @param {GitServerOptions} options Server configuration options
 * @returns {http.Server} The created HTTP server instance
 */
function createGitServer({ port = 9000, gitDir = null, authenticate }) {
    console.log('[GitServer] Creating server instance with options:', {
        port,
        gitDir,
        hasAuthenticator: !!authenticate
    });

    if (!gitDir) {
        console.error('[GitServer] ERROR: gitDir option is required');
        throw new Error('gitDir option is required');
    }

    const server = http.createServer((req, res) => {
        console.log(`[GitServer] Incoming ${req.method} request to ${req.url}`);
        console.log('[GitServer] Request headers:', req.headers);

        // Handle CORS preflight requests
        if (req.method === 'OPTIONS') {
            console.log('[GitServer] Handling CORS preflight request');
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
            console.log('[GitServer] Executing authentication middleware');
            authenticate(req, res, () => {
                console.log('[GitServer] Authentication successful, proceeding to git handler');
                handleGitRequest(req, res);
            });
        } else {
            console.log('[GitServer] No authentication configured, proceeding to git handler');
            handleGitRequest(req, res);
        }
    });

    function handleGitRequest(req, res) {
        console.log('[GitServer] Creating git-http-backend instance for request');

        // Handle gzip encoded requests
        const reqStream = req.headers['content-encoding'] === 'gzip'
            ? req.pipe(zlib.createGunzip())
            : req;

        console.log('[GitServer] Request encoding:', req.headers['content-encoding'] || 'none');

        // Create git-http-backend instance
        const backend = new Backend(req.url, (err, service) => {
            if (err) {
                console.error('[GitServer] Backend error:', err);
                res.writeHead(500);
                res.end(err.toString());
                return;
            }

            console.log('[GitServer] Service details:', {
                type: service.type,
                action: service.action,
                cmd: service.cmd,
                args: service.args
            });

            res.setHeader('content-type', service.type);

            // Spawn git process with correct directory
            console.log(`[GitServer] Spawning git process: ${service.cmd} ${service.args.join(' ')}`);
            console.log(`[GitServer] Working directory: ${gitDir}`);

            const ps = spawn(service.cmd, service.args.concat(gitDir), {
                cwd: gitDir
            });

            // Log process events
            ps.on('error', (error) => {
                console.error('[GitServer] Git process error:', error);
            });

            ps.stderr.on('data', (data) => {
                console.log('[GitServer] Git process stderr:', data.toString());
            });

            ps.on('exit', (code, signal) => {
                console.log('[GitServer] Git process exited:', { code, signal });
            });

            ps.stdout.pipe(service.createStream()).pipe(ps.stdin);
        });

        reqStream.pipe(backend).pipe(res);
    }

    // Add server event handlers
    server.on('error', (error) => {
        console.error('[GitServer] Server error:', error);
    });

    server.on('close', () => {
        console.log('[GitServer] Server closed');
    });

    // Start the server
    server.listen(port, () => {
        console.log(`[GitServer] Server listening on port ${port}`);
        console.log(`[GitServer] Serving git repository from: ${gitDir}`);
        console.log('[GitServer] Server configuration:', {
            port,
            gitDir,
            hasAuthenticator: !!authenticate,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch
        });
    });

    return server;
}

module.exports = createGitServer;
