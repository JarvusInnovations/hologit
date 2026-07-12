/**
 * Tests for WatchLoop — the serialized, latest-wins cycle runner behind
 * `project --watch` (specs/behaviors/watch.md): coalescing of rapid inputs,
 * the publication-gate supersession rule, error isolation, and ordering.
 */

const WatchLoop = require('../../lib/WatchLoop.js');

/** A manually-resolvable promise. */
function deferred () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('WatchLoop', () => {

    test('requires cycle and publish handlers', () => {
        expect(() => new WatchLoop({})).toThrow('cycle and publish handlers required');
    });

    test('runs a cycle and publishes its result', async () => {
        const published = [];
        const loop = new WatchLoop({
            cycle: async (input) => `projected:${input}`,
            publish: async (result, input) => published.push([result, input])
        });

        await loop.push('a');
        expect(published).toEqual([['projected:a', 'a']]);
    });

    test('serializes cycles and coalesces a burst to the newest input', async () => {
        const gates = [];
        const projected = [];
        const published = [];

        const loop = new WatchLoop({
            cycle: async (input) => {
                projected.push(input);
                const gate = deferred();
                gates.push(gate);
                await gate.promise;
                return `projected:${input}`;
            },
            publish: async (result) => published.push(result)
        });

        const idle = loop.push('a');
        // a burst of inputs while cycle 'a' is in flight
        loop.push('b');
        loop.push('c');
        loop.push('d');

        gates[0].resolve(); // finish cycle 'a' — superseded by 'd'
        while (gates.length < 2) {
            await new Promise(resolve => setImmediate(resolve)); // let the loop reach the next cycle
        }
        gates[1].resolve(); // finish the follow-up cycle
        await idle;

        // intermediate inputs b and c were never projected at all
        expect(projected).toEqual(['a', 'd']);
        // cycle 'a' hit the publication gate superseded and was discarded
        expect(published).toEqual(['projected:d']);
    });

    test('publishes every input when cycles keep pace', async () => {
        const published = [];
        const loop = new WatchLoop({
            cycle: async (input) => `projected:${input}`,
            publish: async (result) => published.push(result)
        });

        await loop.push('a');
        await loop.push('b');
        await loop.push('c');

        expect(published).toEqual(['projected:a', 'projected:b', 'projected:c']);
    });

    test('a cycle error is reported and does not stop the loop', async () => {
        const published = [];
        const errors = [];

        const loop = new WatchLoop({
            cycle: async (input) => {
                if (input == 'boom') {
                    throw new Error('cycle failed');
                }
                return `projected:${input}`;
            },
            publish: async (result) => published.push(result),
            onError: (err, input) => errors.push([err.message, input])
        });

        await loop.push('boom');
        await loop.push('ok');

        expect(errors).toEqual([['cycle failed', 'boom']]);
        expect(published).toEqual(['projected:ok']);
    });

    test('a publish error is reported and does not stop the loop', async () => {
        const errors = [];
        let publishes = 0;

        const loop = new WatchLoop({
            cycle: async (input) => input,
            publish: async (result) => {
                publishes++;
                if (result == 'bad') {
                    throw new Error('publish failed');
                }
            },
            onError: (err, input) => errors.push([err.message, input])
        });

        await loop.push('bad');
        await loop.push('good');

        expect(errors).toEqual([['publish failed', 'bad']]);
        expect(publishes).toBe(2);
    });

    test('an input pushed during publish supersedes nothing already published', async () => {
        const published = [];
        let loop;

        loop = new WatchLoop({
            cycle: async (input) => `projected:${input}`,
            publish: async (result) => {
                published.push(result);
                if (result == 'projected:a') {
                    loop.push('b'); // arrives after 'a' passed its gate
                }
            }
        });

        await loop.push('a');

        // 'a' was already published when 'b' arrived; 'b' publishes after it
        expect(published).toEqual(['projected:a', 'projected:b']);
    });
});
