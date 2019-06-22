const commandName = 'ls';
const { command, handler } = require(`./${commandName}`);

test('exports command', () => {
    expect(command).toBe(commandName);
});

test('exports handler', () => {
    expect(typeof handler).toBe('function');
});
