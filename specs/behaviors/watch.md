# Behavior: Watch mode (continuous re-projection)

## Rule

Watch mode re-runs a projection whenever its input state changes: the watched
ref advances (ref mode) or the working tree is edited (working-tree mode).
Each **cycle** projects exactly the input state it observed and publishes one
result (an output line, plus a ref advance when committing). Cycles are
**serialized and latest-wins**: rapid changes coalesce, intermediate states
may be skipped entirely, and a cycle whose input has been superseded by a
newer change may be abandoned before publication — the last published result
always corresponds to the newest observed input.

**The engine does not watch.** Filesystem and ref monitoring is a side effect
owned by the host (the CLI, or any embedding consumer); the engine's
contribution is a warm **projection session** that makes repeat projections
cheap. The engine carries no watcher dependency and no event loop.

## Applies To

- `commands/project.js` (`--watch`) — the projection watch loop
- `commands/watch.js` — bare watch (publishes input hashes only, no projection)
- `lib/Repo.js` `Repo#watch` — the trigger source (watchman / chokidar)
- `holo-projector-napi` `ProjectionSession` (see `specs/api/projector-napi.md`)
- `specs/behaviors/projection-commits.md` — per-cycle commit behavior

## Details

### Triggers

| Mode | Watched state | Mechanism | Cycle input |
| --- | --- | --- | --- |
| Ref mode (default) | The watched ref (`--ref`, default `HEAD`), following symbolic refs — a re-target of `HEAD` re-subscribes to the new branch | Host file-watch on the ref files under the git dir (chokidar today) | The ref's new commit and its root tree |
| Working-tree mode (`--working`) | The repository's working tree, excluding the git dir and editor droppings (swap/backup files) | Host filesystem watcher (watchman today), VCS-aware deferral enabled | The working tree hashed to a root tree via the holoindex (`Repo#hashWorkTree`) |

A change event that does not change the effective input (same ref target, or
a tree hash identical to the previous cycle's) publishes nothing — duplicate
suppression is by hash, not by event.

Ref watching must survive git's rename-based ref updates. Two observed (not
theoretical) inotify failure modes: a file-level watch is permanently
orphaned by the first rename-over (later updates fire no event at all), and
even a directory-level watch can coalesce a rapid burst into one event
delivered *before* the burst's final state. Event *coalescing* is harmless —
the handler reads the ref's current value at processing time — but event
*loss* violates "the newest observed state always wins". The watcher
therefore layers a low-latency event path (the ref's parent directory,
filtered by path) over a stat-polling safety net per watched ref, whose
interval bounds the worst-case detection delay for a dropped event.

### The watcher belongs to the host

The engine stays pure (`principles.md#composition-is-pure-side-effects-live-at-the-edges`):
it never registers filesystem watchers, polls refs, or owns a debounce timer.
The host observes changes and calls the engine once per cycle. This is a
deliberate event-boundary decision:

- Embedding consumers (gitsheets watch is tracked demand) already have their
  own change sources (transactions, HTTP hooks); they need a fast re-project
  primitive, not a second watcher competing with theirs.
- Watcher choice stays a host concern: the CLI keeps watchman for working
  trees (VCS-aware `defer_vcs`, editor-noise filtering proven in production)
  and chokidar for ref files. Replacing either never touches the engine. An
  engine-side `notify` dependency was considered and rejected: it would fold
  platform event semantics into the pure core for zero determinism benefit.

### Debounce and coalescing

Change events are debounced (a short, implementation-defined window; 50ms
ported from the oracle) and coalesced: however many events arrive while a
cycle is in flight, **at most one** follow-up cycle runs, using the newest
input state at the moment it starts. A burst of N saves produces between 1
and N published results; the final one always reflects the last save.

### Supersession

A cycle whose input is superseded mid-flight (a newer change was observed
after the cycle started) MAY be abandoned at any checkpoint before
publication, and MUST NOT publish after a newer cycle has published.
Composition itself is a synchronous engine call and is not interruptible; the
mandatory checkpoint sits at the **publication gate** — after the output hash
exists, before the output line and any commit. A superseded cycle that has
reached its gate discards its result silently; the pending newer cycle runs
immediately. (This subsumes the intent of #19 — "cancel" means "never
publish", not "tear down mid-computation".)

### Per-cycle publication

- Watch start performs an initial projection immediately (before any change)
  and publishes it — a watch session's first output is always the current
  state, never silence until an edit.
- Each published cycle emits exactly one line to stdout: the projected tree
  hash, or the projection commit hash when committing. Diagnostics go to the
  log stream, never stdout.
- A cycle that fails (projection error, lens failure, `REF_CONFLICT`)
  publishes nothing, reports the error on the log stream, and the watch
  continues — the next change triggers a normal cycle. Watch only exits on
  cancellation or a watcher error.

### Committing cycles (`--commit-to`)

Each published cycle that commits does so per
`specs/behaviors/projection-commits.md`, with per-mode inputs:

- **Ref mode**: source commit = the watched ref's new commit (second parent +
  `Source-commit` trailer); source description = `git describe --always
  --tags` of the watched ref, host-computed per cycle.
- **Working-tree mode**: no source commit for watch cycles (the working tree
  is not a commit); the `from` clause is the work-tree path. (Oracle quirk,
  ported: the *initial* projection of a `--working --watch` session still
  passes the ref's commit as source parent — only change-triggered cycles
  omit it.)
- The first parent is the target ref's value observed at cycle start; the
  advance is compare-and-swap on it. An external writer moving the target ref
  mid-cycle surfaces as `REF_CONFLICT` (`specs/api/errors.md`) — the cycle
  fails as above, and the next cycle re-resolves the ref fresh. Watch never
  clobbers an external write. Successive watch cycles are serialized, so the
  loop never conflicts with itself.

### Warm session and staleness

Watch cycles run through a persistent engine session
(`specs/api/projector-napi.md` § ProjectionSession) holding the repository
handle and content caches across cycles. The staleness contract that makes
this safe:

| State | Cached across cycles? | Why |
| --- | --- | --- |
| Tree/blob/commit content, parsed-tree cache (`TreeCache`), object cache | Yes, indefinitely | Content-addressed: the key fully determines the content (`principles.md#a-content-addressed-key-captures-exactly-what-determines-the-output`); reuse is a performance choice, never a correctness risk |
| Ref values (source heads, target refs, `HEAD`) | **Never** | Mutable state; every cycle re-resolves refs from the repository |
| Object presence (packs, loose objects written by other processes between cycles) | Re-checked | New objects — e.g. trees the host hashed from the working tree — must be visible to the session without reopening it |

A session serving a stale ref value or failing to see an externally written
object is a correctness bug, not a performance trade-off — worse than a cold
open, because it silently projects the wrong input. Conformance: session
tests write refs and objects behind an open session and assert the next call
observes them.

### Re-projection scope

A cycle re-projects the watched holobranch in full from its new root tree.
There is no incremental/differential projection: warmth comes from
content-addressed caches making unchanged subtrees cheap, not from diffing.
(If working-tree hashing cost comes to dominate cycle latency at scale,
incremental *hashing* is the follow-up — never partial re-projection, which
would trade hash-identity for speed.)

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Composition is pure; side effects live at the edges](../principles.md#composition-is-pure-side-effects-live-at-the-edges) —
  watching is an edge: the host observes and triggers; the engine only
  projects.
- [Determinism is the product](../principles.md#determinism-is-the-product) —
  a watch cycle's output is hash-identical to a one-shot projection of the
  same input state; session warmth may never change a result, only its
  latency.
- [A content-addressed key captures exactly what determines the output](../principles.md#a-content-addressed-key-captures-exactly-what-determines-the-output) —
  the staleness table above is this principle applied to session state:
  immutable-by-key is cached, mutable is re-read.

**Local:**

- **The newest observed state always wins.** When throughput and freshness
  conflict (bursts, slow cycles), watch drops intermediate results rather
  than queueing them: never publish two results out of input order, never
  finish a session on anything but the latest input. A consumer of the watch
  stream may treat each published line as "current as of publication".
