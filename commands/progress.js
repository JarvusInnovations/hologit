exports.command = 'progress';
exports.desc = 'Progress demo';

exports.handler = async function progress () {
    const execa = require('execa');
    const execao = require('execa-output');
    const Listr = require('listr');

    const tasks = new Listr([
        {
            title: 'Git',
            task: () => {
                return new Listr([
                    {
                        title: 'Checking git status',
                        task: () => execa.stdout('git', ['status', '--porcelain']).then(result => {
                            if (result !== '') {
                                throw new Error('Unclean working tree. Commit or stash changes first.');
                            }
                        })
                    },
                    {
                        title: 'Checking remote history',
                        task: () => execa.stdout('git', ['rev-list', '--count', '--left-only', '@{u}...HEAD']).then(result => {
                            if (result !== '0') {
                                throw new Error('Remote history differ. Please pull changes.');
                            }
                        })
                    }
                ], {concurrent: true});
            }
        },
        {
            title: 'Projecting holobranch',
            task: (ctx, task) => execao('git', ['holo' ,'project', 'emergence-site'])
        },
        // {
        //     title: 'Install package dependencies with npm',
        //     enabled: ctx => ctx.yarn === false,
        //     task: () => execa('npm', ['install'])
        // },
        // {
        //     title: 'Run tests',
        //     task: () => execa('npm', ['test'])
        // },
        // {
        //     title: 'Publish package',
        //     task: () => execa('npm', ['publish', '--dry-run'])
        // }
    ]);

    tasks.run().catch(err => {
        console.error(err);
    });
};
