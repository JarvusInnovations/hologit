# Behavior: Lensing (container-based tree transformation)

## Rule

A lens is a **deterministic, content-addressed transformation of one git tree into another**, executed inside an OCI container. Given the same spec (lens configuration + digest-pinned image identity + input tree hash), lens execution must produce the same output tree — which is what makes lens results cacheable and shareable across machines. Lensing is an edge capability layered around pure composition: composition never executes lenses; lens execution never recomposes.

## Applies To

- `lib/Lens.js` (legacy engine, current implementation)
- The future Rust lens executor (#435)
- Lens images (`ghcr.io/hologit/lenses/*` and third-party)
- Watch mode (#437) as the primary consumer of warm execution

## Status of this spec

Two kinds of content, per the conformance-oracle principle:

- **Ported behavior** (sections: Input, Spec, Cache, Output) — semantics carried over from the JS engine unchanged; conformance is hash-identity with existing lensed projections.
- **Desired-state changes** (sections: Runtime, Identity resolution, Job protocol, Lifecycle) — deliberate redesign, settled here spec-first. The JS engine's current transport (fixed host port 9000, shared force-pushed `lens-input` branch, `nc` readiness polling, registry-only digest lookup) is superseded by this spec, not preserved.

Provenance note: the spec/key/cache model dates to the original Habitat-based lensing and is the proven core of the design. The current network transport was an expedient port executed under time pressure when Habitat stopped working — good enough to get things building again, never a settled design. This spec keeps the former and retires the latter.

## Input (ported)

- The lens input tree is built from the projection output: re-rooted at `input.root` (default `.`), filtered by `input.files` globs (default `**`), per the composition spec's glob semantics.
- Input construction is pure tree work; no lens code runs.

## Spec and content addressing (ported, one change)

- A lens spec captures the complete execution identity: normalized lens config, resolved container identity (digest form), and the input tree hash. The spec is written as a content-addressed object; its hash keys all caching.
- Anything that can change the output must be inside the spec; nothing else may be. (Corollary: lens execution must not read clocks, network, or host state — a lens that does so is defective, and its cache entries are poison.)
- **Change:** the spec travels to the lens as a file, not a commit message. The job input commit's tree is a wrapper: `.holospec/lens.toml` alongside `input/` (the input tree). The output commit's tree is the bare result, unwrapped. Commit messages stay human-readable.

## Container identity resolution (desired state)

Resolution ladder, tried in order at spec-build time:

1. **Explicit digest pin** in config (`container = "ghcr.io/…/helm3@sha256:…"`) — no lookup performed. This is the documented, recommended form; floating tags are discouraged in the docs because they silently change specs and bust caches.
2. **Local engine lookup** — the digest of a locally present image matching the tag.
3. **Registry lookup** — a manifest HEAD request over plain OCI registry HTTP (no container-engine CLI dependency).

Rules:

- A warm result cache must be usable **offline**: if step 1 or 2 resolves, no network is touched.
- A **local-only image** (never pushed) is usable (#417): its locally-resolved identity enters the spec with an explicit `resolved = "local"` marker. Such specs cache correctly on that machine and are honestly non-portable — an unpushed image has no cross-machine identity, and the spec says so rather than failing.

## Job protocol (desired state)

One contract for all lens images; no port publishing, no readiness polling.

- **Transport is exec'd stdio**: git protocol tunneled over `exec` into the container (`ext::`-style transports), or a git bundle piped through stdin/stdout for one-shot runs. No network listener is required or permitted by the contract; nothing binds host ports.
- **Per-job refs** inside the container's repo, keyed by spec hash:
  - `refs/jobs/<spec-hash>/input` — pushed by the engine (the wrapper commit).
  - `refs/jobs/<spec-hash>/output` — written by the lens on success: a commit whose **first parent is the input commit** (integrity check, ported) and whose tree is the result.
  - `refs/jobs/<spec-hash>/error` — written on failure: a commit whose tree contains at minimum `exit-code` and `log` entries. Structured failure is part of the contract; "no output ref appeared" is a transport error, never a lens error.
- Distinct spec hashes are distinct jobs: **one container may execute many jobs, concurrently or sequentially**, with no shared mutable refs between them.
- **Deadlines and supersession**: every job carries a deadline (config `timeout`, engine default); the engine cancels jobs whose deadline passes or whose result is no longer wanted (a newer projection superseded it — #19). Cancellation is a ref deletion plus process signal; a cancelled job must leave no partial `output` ref.
- **One-shot mode**: the same contract collapsed to a single exchange — wrapper bundle on stdin, result (or error) bundle on stdout, exit code mirroring success/error — for `run --rm`-style execution with no persistent container.

## Container lifecycle (desired state)

- **One-shot** (default for CI): create, run job over stdio, remove. Stateless and simplest; transfers the full input each run.
- **Warm pool** (default for watch mode and multi-lens projections): at most one container per image digest, kept for the duration of the run/session; jobs multiplex over per-job refs. Warm containers retain repo objects, so successive pushes transfer only deltas — successive watch-mode projections ship only what changed. The engine owns pool lifecycle (start on first use, reap on session end or idle timeout); an engine crash must not orphan containers silently (label them for discovery and cleanup).
- The trade-off is explicit: one-shot = stateless + full transfer; warm = incremental + engine-managed state. Both sit behind the identical job protocol; lens images cannot tell which mode they run in.

## Object transfer

Three sanctioned tiers, all behind the same job protocol; transfer strategy is an engine concern and never part of the spec hash:

1. **Full** (one-shot cold case): the input reaches the container as a complete push/bundle.
2. **Incremental** (warm pool): the container retains objects across jobs; pushes transfer only new objects.
3. **Lazy** (either mode): the container repo is configured with the engine as a **promisor remote over the same exec'd-stdio connection**; objects are fetched on demand as the lens reads them. Zero upfront transfer; only objects the lens actually touches ever cross. This is the sanctioned way to get alternates-like economics.

**Read-only object-DB mounts (alternates) are not part of the contract.** Sharing the host object database into the container via bind mount was prototyped historically and is structurally fragile: it assumes a same-host daemon and compatible uid mapping (breaks under remote daemons, DinD, rootless, and VM-backed engines, where per-object filesystem access is also pathologically slow), it races host-side GC/repack with no cross-process coordination, and it exposes the entire object DB — including private source history — to lens code, where transport exposes only the input-reachable set. An engine MAY offer an alternates mount as an opt-in local fast path when it can verify same-host daemon and uid compatibility and suppress GC for the job's duration, but behavior must be observably identical to transport mode and lens images must not be able to depend on it.

## Cache (ported)

- Results are cached at the spec-keyed ref (`refs/holo/lens/…`); `cacheFrom`/`cacheTo` fetch/push those refs against remotes, with tracking refs preventing redundant pushes. Cache reads are trusted without re-execution (content-addressing is the integrity model).
- Rust-written and JS-written cache refs must be mutually readable during the hybrid period.

## Output (ported)

- The result tree merges back into the projection at `output.root` (default: `input.root`) with `output.merge` mode (default `overlay`), per the composition spec's merge modes.

## Runtime decision

**OCI-only.** Habitat package execution (`config.package`, BLDR depot lookup, studio-mediated exec) is deprecated and not ported to the Rust engine. Existing Habitat lenses migrate by wrapping their tool in an image build; a minimal lens SDK (an entrypoint script implementing the job protocol) ships with the lens image toolchain so a lens image is `FROM <anything>` + the SDK + the tool. The engine abstracts the container runtime behind the exec/stdio seam — Docker and Podman are equally supported; nothing in this spec may depend on Docker-specific tooling.

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Determinism is the product](../principles.md#determinism-is-the-product) — the spec-hash cache is sound only because lenses are required to be pure functions of their spec; identity resolution exists to pin the one input (the image) the config expresses symbolically.
- [Composition is pure; side effects live at the edges](../principles.md#composition-is-pure-side-effects-live-at-the-edges) — lensing is the canonical edge: it wraps composition output, never participates in it.
- [The legacy engine is the conformance oracle](../principles.md#the-legacy-engine-is-the-conformance-oracle) — applies to lens *semantics* (input/spec/cache/output); the transport/runtime is deliberately redefined by this spec, which is exactly the sanctioned spec-first path for diverging from the oracle.

**Local:**

- **No hidden image contracts.** Everything a lens image must implement is stated in the job protocol; the engine may not depend on incidental image contents (shells, `nc`, specific servers). If the engine needs a capability, it goes in the protocol and the SDK.
