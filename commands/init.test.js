const init = require('./init');

test('init exports command', () => {
  expect(init.command).toBe('init');
});

test('init exports handler', () => {
  expect(typeof init.handler).toBe('function');
});
