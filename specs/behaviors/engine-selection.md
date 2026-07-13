# Behavior: Engine selection (hybrid Rust/JS projection)

## Rule

The CLI projects holobranches through a **hybrid pipeline**: pure composition
runs in the Rust engine (`holo-projector`, via the `holo-projector-napi`
binding) whenever the projection shape allows, and the JS engine keeps
ownership of all side effects — fetching, lensing, commits (see § Commit
dispatch), watch triggers. Any
projection the Rust path cannot handle falls back to the full JS engine
**observably** (exactly one logged line stating why), never silently. Both
paths produce hash-identical output; engine selection is a performance
decision, never a behavior decision.

## Applies To

- `lib/Projection.js` (`Projection.projectBranch`) — the dispatch point
- `lib/ProjectionPlan.js` (`ProjectionPlan.project`)
- `lib/RustEngine.js` — the dispatcher/loader
- `holo-projector-napi` (see `specs/api/projector-napi.md`)

## Details

### The seam is per-phase, per-projection

A projection is composed and then (optionally) lensed. The seam sits between
those phases:

1. **Composition** runs in Rust via `compositeBranch`, producing the
   **pre-lens tree** (`.holo/{branches,sources}` stripped; `.holo/config.toml`
   and `.holo/lenses` retained). This tree must be hash-identical to the JS
   engine's post-composite state — since lens input trees are
   content-addressed, identical pre-lens trees guarantee identical lensed
   output.
2. **Lensing** (when enabled) runs in the existing JS lens pipeline against
   that tree, followed by the final metadata strip, tree write, and any
   commit — all JS.

The seam recurses through fallback: when a projection falls back to the JS
engine, each of its recursive sub-projections is dispatched independently
(`Source.getOutputTree` → `Projection.projectBranch`), so a single
Rust-ineligible projection does not drag its whole graph onto the JS path.

### Eligibility (fallback conditions)

The Rust composition path is used unless one of these holds, each of which
falls back to the JS engine with a single logged line naming the condition:

| Condition | Why |
| --- | --- |
| Addon not built/loadable | The binding is an optional native artifact; a pure-JS install must behave exactly as before it existed. Degradation is silent-by-default here (debug log), because it is the documented npm-consumer state, not an anomaly. |
| `fetch` requested | Fetching is a side effect owned by JS; the Rust engine only reads local refs. |
| Working-tree mode with a checked-out source sub-worktree (`repo.workTree` set **and** any directory exists under `<workTree>/.holo/sources/`) | Source heads may be hashed from checked-out sub-worktrees — filesystem state the Rust engine does not read. Without sub-worktrees the JS oracle resolves source heads from gitlinks and refs exactly as the Rust engine does, so a working-tree projection whose root tree was already hashed (`Repo#hashWorkTree`) is tree-pure and Rust-eligible — the case watch mode's working-tree cycles live on. |
| `HOLO_SOURCE_*` environment overrides present | The Rust engine reads source config only from the tree. |
| Phantom (programmatic) branch/source config | In-memory config objects are invisible to an engine that reads config from the tree. `ProjectionPlan` instead uses the binding's `projectPlan` entry point, which accepts structured config directly. |
| The binding throws (e.g. `SOURCE_RESOLUTION` for an unfetched source, `LENSED_SUBPROJECTION`) | The JS engine can resolve what Rust refused: it fetches on demand and lenses sub-projections. |

### Commit dispatch

`--commit-to` commits are created per `specs/behaviors/projection-commits.md`
by either engine — both produce byte-identical commits from the same inputs.
Ownership today:

- **Default (hybrid) and `HOLO_ENGINE=js`**: the JS engine commits (the
  oracle path). JS remains the default committer until the CI parity gate
  (below) has demonstrated commit-hash equality in production use; flipping
  the default is a future spec change.
- **`HOLO_ENGINE=rust`**: the commit is created through the binding's
  `commitProjection` (warm session), with the host supplying the
  `git describe --always --tags` provenance string and identity exactly as
  the oracle computes them. Any failure is a thrown error, never a silent
  fallback — this is what lets CI assert the Rust commit path ran.

The CI gate extends the hash-equality conformance to commits: the fixture
projections run with `--commit-to` under both engines with pinned identity
(`GIT_AUTHOR_*`/`GIT_COMMITTER_*`) and the resulting **commit hashes** must
be equal.

### Warm engine context

Rust-path projections run through a per-repository `ProjectionSession`
(`specs/api/projector-napi.md` § ProjectionSession) owned by the dispatcher
and keyed to the `Repo` instance, so repeat projections in one process —
watch cycles above all — reuse the repository handle and content caches.
Session reuse is invisible in output hashes (warmth is never a behavior
decision); the staleness contract lives with the session spec.

### `HOLO_ENGINE` override

- `HOLO_ENGINE=js` — never attempt the Rust path.
- `HOLO_ENGINE=rust` — require the Rust path: any condition that would fall
  back becomes a **thrown error** instead. This is what lets CI assert the
  Rust path actually ran rather than silently falling back.
- Unset (default) — hybrid dispatch as described above.

### Observability

- Rust-path composition logs one line identifying the engine and the
  composed tree hash.
- Every fallback logs exactly one line: the projection name and the reason.
- Addon-not-built degradation logs at debug level only (see table above).

## Conformance

`docs-site` and `github-action-projector` (this repo) must produce identical
final output hashes under `HOLO_ENGINE=js` and `HOLO_ENGINE=rust` on the same
commit — both lens at the top level, so this exercises the full hybrid seam.
CI enforces this on every PR. `emergence-site`
(CodeForPhilly/codeforphilly.org) is the at-scale fixture for the same
invariant.

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Composition is pure; side effects live at the edges](../principles.md#composition-is-pure-side-effects-live-at-the-edges) —
  the seam is drawn exactly on that boundary: the pure phase moves to Rust,
  the edges stay where they already work.
- [The legacy engine is the conformance oracle](../principles.md#the-legacy-engine-is-the-conformance-oracle) —
  fallback exists so that unsupported shapes get oracle behavior, not
  approximations of it.
- [Determinism is the product](../principles.md#determinism-is-the-product) —
  engine choice must be invisible in the output hash.

**Local:**

- **Fall back, never diverge.** When the Rust path cannot reproduce the
  oracle's output exactly, the correct behavior is refusing (a structured
  error the dispatcher converts to a logged fallback), never a silent
  approximation. A wrong hash from the fast path is strictly worse than a
  slow correct one.
