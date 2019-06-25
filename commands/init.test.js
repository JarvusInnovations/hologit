const commandName = 'init';
const { command, handler } = require(`./${commandName}`);

test('exports command', () => {
    expect(command).toBe(commandName);
});

test('exports handler', () => {
    expect(typeof handler).toBe('function');
});

test('outputs initialized repo\'s config', async () => {
    const spy = jest.spyOn(console, 'log');

    const result = await handler();

    expect(spy.mock.calls.length).toBe(2);
    expect(spy.mock.calls).toEqual([
        ['name=hologit'],
        ['initialized .holo/config.toml']
    ]);

    expect(result).toEqual({
        name: 'hologit'
    });
});
