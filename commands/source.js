exports.command = 'source <command>';
exports.desc = 'Manage set of sources';
exports.builder = yargs => yargs.commandDir('source', { exclude: /\.test\.js$/ });
