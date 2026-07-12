# API: Lens SDK (the in-image job-protocol adapter)

## Summary

The lens SDK is the entrypoint layer inside a lens image that implements the v2 job protocol ([behaviors/lensing.md](../behaviors/lensing.md) § Job protocol) and adapts it to the lens's transform tool. The protocol governs what crosses the container boundary; **this spec governs the contract between an SDK and the lens author** — the environment, paths, and lifecycle a transform is written against — so that a transform behaves identically under any conforming SDK.

Two implementations exist: the reference SDK (`lens-sdk/lens-job.sh`, POSIX shell + git only) and the lenses base-image SDK (`ghcr.io/hologit/lenses`, adapted from the v1 hook machinery). Divergence between them is exactly what this spec exists to prevent.

## Status of this spec

- **Ported behavior** (Command-wrapper interface): the env/placeholder surface carried from the v1 hook machinery; migrated transforms depend on it unchanged.
- **Desired state** (Per-job isolation, Git-native mode, Incremental materialization): requirements ahead of current implementations, settled here spec-first. Known conformance gaps are flagged inline.

## Applies To

- `lens-sdk/lens-job.sh` (reference implementation)
- The lenses base-image SDK (hologit/lenses; gaps tracked on [hologit/lenses#33](https://github.com/hologit/lenses/pull/33))
- Third-party images that advertise the command-wrapper interface. An image implementing the job protocol with its own entrypoint and no SDK is fully conforming to *lensing* — this spec binds it only if it runs author-supplied `command` transforms.

## The boundary

Everything between ingesting the input bundle and emitting the result bundle is SDK-internal (per lensing.md); nothing in this spec is visible to the engine, and nothing here may alter the output tree a given transform produces. **Materialization is an SDK convenience, not a protocol requirement** — the protocol is trees-in/trees-out over refs, and a git-native transform that reads input objects with plumbing and emits an output tree hash never needs a checkout.

## Command-wrapper interface (file mode; ported)

The default mode wraps an existing file-oriented tool. Per job, the SDK:

- Materializes the wrapper tree (`.holospec/` + `input/`) and creates an empty output directory.
- Runs the spec's `command` via the image's shell with:
  - cwd = the materialized wrapper root (so `.holospec/` and `input/` are both visible)
  - `HOLOLENS_INPUT` — absolute path of the materialized `input/` directory
  - `HOLOLENS_OUTPUT` — absolute path of the empty directory the command must populate with its result
  - `HOLOLENS_SPEC` — absolute path of `.holospec/lens.toml`
  - every scalar spec key squished to a `HOLOLENS_*` environment variable (v1-compatible), **excluding `_`-prefixed engine-bookkeeping keys** (lensing.md § Container identity resolution)
  - `{{ input }}` and `{{ output }}` placeholders in `command` substituted with those absolute paths
- Captures the command's stdout+stderr as the job log, relayed on the entrypoint's stderr — the entrypoint's stdout carries only the result bundle.
- On success, commits the output directory as the bare result tree (first parent: the input commit). On failure, emits the error commit per the protocol.
- **Exit-code passthrough**: the error commit's `exit-code` is the command's own exit status — never an SDK constant. This restates the protocol rule as binding on SDKs because it is where implementations drift. *Known gap: the base-image SDK currently reports the wrapper's status (always 1); flagged on hologit/lenses#33.*

## Per-job isolation (required)

All job state — the job repo, materialization, output directory, log — lives under a per-job private path (e.g. a `mktemp -d` per job). Fixed global paths are non-conforming.

Rationale: the protocol promises that one container may execute many jobs concurrently and that images cannot detect one-shot vs. warm mode. Both promises are broken by shared job state — a warm container multiplexing jobs over fixed paths corrupts them. Isolation at the SDK layer is what makes the warm pool deployable without touching any image. *Known gap: the base-image SDK serializes job state through fixed `/repo` + `/working` paths; flagged on hologit/lenses#33 and a precondition for warm-pool rollout.*

## Git-native mode (desired state)

Not every transform wants files: some operate on git objects directly, and forcing a full checkout on them wastes the exact I/O the transfer tiers save (a full materialization faults in every object, defeating tier-3 lazy fetch; a git-native transform reading three blobs from a 10,000-file tree fetches roughly three blobs).

In git-native mode the SDK skips materialization and runs `command` with:

- `HOLOLENS_GIT_DIR` — the job repo (also exported as `GIT_DIR`)
- `HOLOLENS_INPUT_COMMIT` / `HOLOLENS_INPUT_TREE` — the input commit and the hash of its `input/` subtree
- `HOLOLENS_SPEC` — path to an extracted `.holospec/lens.toml` (the spec file is still materialized; the input tree is not)
- `HOLOLENS_OUTPUT_TREE` — path of a file the command must write the output **tree hash** to (stdout remains the log channel)

The SDK validates the written hash names a tree present in the job repo, then commits and emits it exactly as in file mode.

**Mode selection is image-level configuration** (build argument or entrypoint flag baked into the image), never a lens-config spec key: the mode cannot change the output tree, so under [the cache-key principle](../principles.md#a-content-addressed-key-captures-exactly-what-determines-the-output) it must not enter the spec hash.

## Incremental materialization (desired state, warm mode)

Tier-2 transfer makes the *wire* delta-exact for warm containers; a full `git archive` extraction per job then re-pays the full materialization cost every cycle. A warm-mode SDK SHOULD keep a persistent worktree per lens and update it in place between jobs (`git read-tree -u`-style against the retained previous input commit), so watch-cycle cost scales with the change end to end. This is purely an SDK optimization: per-job isolation still applies to everything except the deliberately-retained worktree, and behavior must be indistinguishable from a fresh materialization.

## Transition: dual dispatch

Migrated images currently carry a dual-dispatch entrypoint: stdin at `/dev/null` (how the v1 engine starts containers) execs the legacy git server; stdin carrying data runs the v2 one-shot SDK. This is image-level compatibility machinery, part of neither contract, and retires with the v1 transport. The engine-facing advertisement is the `sh.holo.lens.protocol` OCI label (lensing.md § Job protocol).

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [A content-addressed key captures exactly what determines the output](../principles.md#a-content-addressed-key-captures-exactly-what-determines-the-output) — SDK plumbing choices (mode, materialization strategy) can never change output, so none of them may enter the spec.

**Local:**

- **SDK plumbing is transform-invisible.** Two conforming SDKs given the same job produce the same output commit tree, and a transform can never observe which SDK, mode, or materialization strategy ran it. Anything a transform could branch on is contract surface and belongs in this spec.
