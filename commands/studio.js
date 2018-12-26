exports.command = 'studio';
exports.desc = false;
exports.builder = {
    socket: {
        describe: 'Path to socket for API to listen on',
        type: 'string',
        default: '/var/run/holo.sock'
    }
};

exports.handler = async function watch ({ socket }) {
    const logger = require('../lib/logger.js');
    const fs = require('mz/fs');


    // check for existing socket file and delete if stale
    if (await fs.exists(socket)) {
        const canConnect = await new Promise(function(resolve, reject) {
            const client = require('net').connect(socket, () => {
                resolve(true);
                client.end();
            });
            client.on('end', () => resolve(false));
            client.on('timeout', () => resolve(false));
            client.on('error', () => resolve(false));
        });

        if (canConnect) {
            throw new Error(`a service is already listening on ${socket}`);
        }

        logger.debug(`deleting stale socket ${socket}`);
        await fs.unlink(socket);
    }


    // listen on socket
    require('http').createServer((request, response) => {
        const { headers, method, url } = request;

        logger.info(`request: ${method}\t${url}`);

        let body = [];
        request.on('error', (err) => {
          logger.error(err);
        }).on('data', (chunk) => {
          body.push(chunk);
        }).on('end', () => {
          body = Buffer.concat(body).toString();
          // At this point, we have the headers, method, url and body, and can now
          // do whatever we need to in order to respond to this request.
          response.end('ok:'+body);
        });
    }).listen(socket);

    logger.info('listening on', socket);
};
