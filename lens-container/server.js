const createGitServer = require('./lib/server');
const path = require('path');

console.log('[Server] Starting git HTTP server process');
console.log('[Server] Process info:', {
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    env: {
        NODE_ENV: process.env.NODE_ENV,
        TZ: process.env.TZ
    }
});

// Get port from environment variable or use default
const PORT = parseInt(process.env.PORT || '9000', 10);
console.log('[Server] Configured port:', PORT, 'from env:', process.env.PORT);

// Get repository directory from environment variable or use default
const GIT_DIR = process.env.GIT_DIR || '/repo';
console.log('[Server] Configured repo directory:', GIT_DIR, 'from env:', process.env.GIT_DIR);

// Log all environment variables
console.log('[Server] Full environment:', Object.keys(process.env).reduce((acc, key) => {
    acc[key] = key.includes('SECRET') || key.includes('KEY') ? '[REDACTED]' : process.env[key];
    return acc;
}, {}));

// Handle process events
process.on('uncaughtException', (error) => {
    console.error('[Server] Uncaught exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Graceful shutdown handler
function handleShutdown(signal) {
    console.log(`[Server] Received ${signal} signal`);
    console.log('[Server] Starting graceful shutdown...');

    // Close the server
    if (server) {
        console.log('[Server] Closing HTTP server...');
        server.close(() => {
            console.log('[Server] HTTP server closed successfully');
            console.log('[Server] Graceful shutdown complete');
            process.exit(0);
        });

        // Force close after timeout
        setTimeout(() => {
            console.log('[Server] Shutdown timeout exceeded, forcing exit');
            process.exit(1);
        }, 5000);
    } else {
        console.log('[Server] No HTTP server to close');
        process.exit(0);
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Create and start the server
console.log('[Server] Initializing git HTTP server');
const server = createGitServer({
    port: PORT,
    gitDir: GIT_DIR,
    authenticate: (req, res, next) => {
        console.log('[Server] Authentication request:', {
            method: req.method,
            url: req.url,
            headers: {
                ...req.headers,
                authorization: req.headers.authorization ? '[REDACTED]' : undefined
            }
        });
        // Basic authentication can be added here if needed
        next();
    }
});

console.log('[Server] Git HTTP server initialization complete');

// Additional server error handling
server.on('error', (error) => {
    console.error('[Server] Server error:', error);
    process.exit(1);
});

server.on('close', () => {
    console.log('[Server] Server closed');
});
