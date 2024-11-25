const createGitServer = require('./lib/server');
const path = require('path');

// Get port from environment variable or use default
const PORT = parseInt(process.env.PORT || '9000', 10);

// Get repository directory from environment variable or use default
const REPO_DIR = process.env.REPO_DIR || '/repo';

// Create and start the server
const server = createGitServer({
    port: PORT,
    repoDir: REPO_DIR,
    authenticate: (req, res, next) => {
        // Basic authentication can be added here if needed
        next();
    }
});

console.log(`Git HTTP server started`);

// exit gracefully on SIGINT
process.on('SIGINT', function() {
    console.log('Gracefully shutting down from SIGINT (Ctrl-C)');
    process.exit(0);
  });
