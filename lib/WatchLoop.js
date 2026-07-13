/**
 * WatchLoop — serialized, latest-wins cycle runner for watch mode
 * (specs/behaviors/watch.md).
 *
 * Inputs pushed while a cycle is in flight coalesce: however many arrive, at
 * most one follow-up cycle runs, using the newest input at the moment it
 * starts. A cycle whose input has been superseded mid-flight discards its
 * result at the publication gate — after `cycle` produced it, before
 * `publish` sees it — so results are never published out of input order and
 * the last published result always corresponds to the newest input.
 *
 * A cycle or publication error is reported via `onError` and never stops the
 * loop: the next pushed input triggers a normal cycle.
 */
class WatchLoop {

    /**
     * @param {object} handlers
     * @param {function} handlers.cycle - async (input) => result; runs the projection
     * @param {function} handlers.publish - async (result, input) => void; the publication gate has passed when called
     * @param {function} [handlers.onError] - (err, input) => void; cycle/publication failures land here
     */
    constructor ({ cycle, publish, onError = null }) {
        if (!cycle || !publish) {
            throw new Error('cycle and publish handlers required');
        }

        this.cycle = cycle;
        this.publish = publish;
        this.onError = onError || (() => {});
        this.pending = null;
        this.draining = null;

        Object.seal(this);
    }

    /**
     * Queue an input state, replacing any not-yet-started one, and start
     * draining if idle. Returns a promise resolving when the loop next goes
     * idle (all queued work done — for tests and graceful shutdown; watch
     * callbacks may ignore it).
     */
    push (input) {
        this.pending = { input };

        if (!this.draining) {
            this.draining = this.drain().finally(() => {
                this.draining = null;
            });
        }

        return this.draining;
    }

    async drain () {
        while (this.pending) {
            const { input } = this.pending;
            this.pending = null;

            try {
                const result = await this.cycle(input);

                // publication gate: a newer input superseded this cycle —
                // discard the result and let the loop continue with it
                if (this.pending) {
                    continue;
                }

                await this.publish(result, input);
            } catch (err) {
                this.onError(err, input);
            }
        }
    }
}

module.exports = WatchLoop;
