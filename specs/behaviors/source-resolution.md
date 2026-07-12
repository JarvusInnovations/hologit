# Behavior: Source resolution and remote fetching

## Rule

A holosource resolves to exactly one commit through a fixed strategy order, and
that resolution is **pure** — it only reads objects and refs already in the
repository. Populating those refs from a remote is a separate **edge
capability**: fetching writes a source's remote ref into a deterministic,
engine-independent cache namespace (`refs/holo/source/...`) that either engine
can then resolve. The ref layout is byte-identical across engines: refs written
by the JS engine satisfy the Rust engine and vice versa (interoperable caches).

## Applies To

- `holo-projector` (`source::resolve`, the `fetch` module, and the
  `*_fetching` entry points)
- `lib/Source.js` (legacy engine — `getHead`/`fetch`; the conformance oracle)
- `git holo source fetch`, `git holo project --fetch`

## Details

### Source spec identity

Every remote source is identified by a **spec hash** derived from its URL
alone (not its ref):

1. Parse the URL into `host` (lowercased) and `path` (lowercased, trailing
   `.git` stripped). A URL starting with `/` is treated as `file://` + path.
   A source with no `url` gets `path = "."` and no host.
2. Render the canonical spec TOML with keys deep-sorted (`host` before
   `path`):

   ```toml
   [holospec.source]
   host = "github.com"
   path = "/codeforphilly/laddr"
   ```

3. The spec hash is the git **blob** SHA-1 of that exact TOML text.

The engine that fetches also writes the spec TOML as a real blob in the ODB
and pins it at `refs/holo/spec/{hash}` (GC protection; makes the spec itself
fetchable). Golden values for the hash computation live in
`holo-projector/tests/source.rs` (computed by running the JS implementation).

### Ref layout (byte-compatible across engines)

A fetched source ref lives at:

```
refs/holo/source/{hash[0:2]}/{hash[2:]}/{ref_suffix}
```

where `ref_suffix` is the source's configured ref with the leading `refs/`
removed (`refs/heads/master` → `heads/master`, `refs/tags/v1.2.3` →
`tags/v1.2.3`). A configured ref is either fully qualified (`refs/...`) or a
bare commit hash (7–40 lowercase hex chars) — hash refs occur in real
configs (e.g. codeforphilly.org pins `google/recaptcha` to a commit), and
their suffix is the hash minus its **first five characters**, because the
legacy engine applies `ref.substr(5)` uniformly. Both engines must produce
this same suffix, quirk included — the cache is only interoperable if they
agree. Anything else has no spec-ref location and cannot be fetched.

The cached ref stores **exactly the object the remote ref points at**: a ref
to an annotated tag stores the tag object, unpeeled. Peeling to a commit
happens at resolution time, never at fetch time.

### Resolution order

Per `composition.md` § Source resolution, each mapping's holosource resolves
in this order — resolution itself never fetches:

1. **Self-source** — the source names the workspace itself; the workspace
   tree is the source.
2. **Gitlink** — a commit entry at `.holo/sources/{name}` in the workspace
   tree.
3. **Spec-ref** — `refs/holo/source/{spec}/{ref_suffix}` (only for sources
   with a `url`).
4. **Local ref** — the configured `ref` resolved in the containing repo,
   **only when the source has no `url`**. A url-bearing source must never
   fall through to a same-named local ref: that ref belongs to the containing
   repo, not the source, and resolving it silently substitutes the wrong
   repository's content.

Refs that point at annotated tags are peeled to commits at every step.

### Fetch semantics

A fetch populates step 3's namespace. The behavior (ported from the JS
engine, byte-for-byte on the ref layout and observable git effects):

- **Refspec**: `+{ref}:refs/holo/source/{spec}/{ref_suffix}` — forced update.
- **Depth**: shallow, `--depth=1`, by default. Fetch history depth is a
  transfer optimization only; it must never change what the cached ref
  points at.
- **Tags**: no tag following (`--no-tags` / equivalent). A fetch writes only
  the refspec's destination ref — never `refs/tags/*` or any other local
  namespace. (Empirically, gix's default tag handling *does* write
  `refs/tags/*`; an engine using gix-native fetch must configure
  `Tags::None`.)
- **Auto-maintenance**: the fetch must run with auto-gc and auto-maintenance
  disabled (`gc.auto=0`, `maintenance.auto=false`) so a background `git gc`
  can never rewrite `.git/shallow` mid-fetch (#450).

### Refresh rules

- **Resolve-or-fetch (lazy)**: when an engine is invoked with fetching
  enabled and step 3 finds no spec-ref for a url-bearing source, it fetches
  once and retries step 3. A spec-ref that already exists is **never**
  implicitly refreshed — staleness is the caller's explicit choice.
- **Explicit refresh**: `git holo source fetch <name>` / `--all`, and
  `git holo project --fetch[=<names>|*]` (also `HOLO_FETCH`), re-fetch even
  when a spec-ref exists, advancing the cache to the remote's current tip.
- **Gitlink recovery**: when a gitlink names a commit absent from the local
  ODB, an engine with fetching enabled recovers in escalating steps: fetch
  the configured ref at depth 1; if the commit is still absent, fetch
  `refs/heads/*` unshallowing the repository; only then fail, reporting that
  the pinned commit is not reachable from the source's branches.
  (`--unshallow` applies only when the repository is actually shallow; a
  complete repository takes an ordinary full fetch.)

### Concurrency (the #450 class)

Concurrent fetches sharing one git dir contend on `.git/shallow`: git aborts
with `fatal: shallow file has changed since we read it`; gix fails fast on
its `shallow.lock`. Requirements:

- Concurrent fetch operations against the same git dir must not corrupt the
  repository **and must not spuriously fail** — an engine must serialize
  shallow-touching fetches per git dir within its process.
- Auto-gc/auto-maintenance stays disabled per fetch (above) so no
  git-spawned background process rewrites `.git/shallow` concurrently.
- Cross-process concurrency (e.g. a lens-server subprocess fetching into the
  same git dir) is not fully solvable by in-process serialization; the
  auto-gc guard removes the known in-tree trigger, and remaining
  cross-process races are the invoking host's responsibility.

### Authentication

Fetch authenticates exactly as `git fetch` does in the invoking environment:
credential helpers, `ssh` agents and config, and URL-embedded credentials all
work unmodified. An engine implementation must not degrade this (this is the
main constraint that keeps the subprocess transport in place — see Status).

### Errors

A fetch failure is distinguishable from a resolution failure
(`specs/api/errors.md` stability rules apply — codes, not message text):

- `SOURCE_FETCH` — the fetch itself failed (network, auth, unknown remote
  ref, git exit ≠ 0). Carries the source name and URL.
- `SOURCE_RESOLUTION` — no strategy resolved the source. When fetching is
  enabled this means resolution *still* failed after the fetch succeeded;
  when fetching is disabled it is the dispatcher's cue that the source may
  simply be unfetched.

### Status: ported behavior vs desired state

| Aspect | State |
| --- | --- |
| Ref layout, spec hash/blob, depth/tags policy, resolution order | **Ported behavior** — implemented in both engines, oracle-verified. |
| Rust lazy resolve-or-fetch + gitlink recovery (`*_fetching` entry points) | **Ported behavior** — mirrors `lib/Source.js` `getHead`. |
| Rust fetch transport | **Declared interim: subprocess `git fetch`.** Byte-identical behavior and auth for free, zero new crate dependencies. |
| gix-native fetch (no `git` binary needed by library consumers) | **Desired state**, not yet implemented. Empirical probe of gix 0.83: shallow depth-1 fetch works over https and ssh with the holo refspec layout, annotated-tag refs stored unpeeled (compatible) — but https requires opting into a TLS-enabled transport feature (`blocking-http-transport-reqwest-rust-tls`; the base reqwest/curl features fail at runtime), the reqwest/rustls tree is a heavy dependency addition, default tag-following writes `refs/tags/*` (must be disabled), ssh spawns the system `ssh` binary anyway, and https credential-helper auth shells out to `git credential`. Revisit when embeddability demands it. |
| Explicit refresh from the Rust engine (`--fetch=<names>` semantics) | **JS-owned for now** — the hybrid CLI routes fetch-requested projections to the JS engine (`engine-selection.md`); the Rust CLI's `--fetch` flag enables lazy resolve-or-fetch only. |

## Conformance fixtures

- `holo-projector/tests/fetch.rs` — layout interop (fixture refs written in
  the JS layout resolve; Rust-written refs match the JS layout byte-for-byte),
  lazy fetch, no-refresh rule, tag peeling through fetch, local-ref
  fallthrough exclusion, concurrent multi-source stress (the #450 regression
  guard).
- End-to-end: a fresh clone with **zero** `refs/holo/source/*` refs projecting
  a holobranch whose sources are all remote (reference:
  CodeForPhilly/codeforphilly.org `emergence-site`) — Rust `--fetch` output
  hash equals the JS engine's on the same commit.

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Composition is pure](../principles.md#composition-is-pure-side-effects-live-at-the-edges) —
  resolution reads, fetch writes; the fetch layer is invoked by the caller at
  the edge (a fetcher hook / pre-step), never spontaneously by composition.
- [The legacy engine is the conformance oracle](../principles.md#the-legacy-engine-is-the-conformance-oracle) —
  the ref layout and fetch flags are whatever `lib/Source.js` observably does;
  divergences (gix tag-following, local-ref fallthrough) are bugs.

**Local**:

- **Interoperable caches beat engine-private state.** Both engines read and
  write the same `refs/holo/source/...` namespace, byte-for-byte. Any
  engine-private cache layout would silently double-fetch and could diverge;
  a candidate optimization that requires one is rejected on that ground.
- **Fetch is explicit; presence is trusted.** An existing spec-ref is never
  re-fetched implicitly. Reproducible projections need resolution to depend
  only on repository state, not on when the network was last consulted.
