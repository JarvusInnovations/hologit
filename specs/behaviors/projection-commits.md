# Behavior: Projection commits

## Rule

Committing a projection — wrapping a composed output tree in a git commit and
advancing a target ref to it — is an **explicit edge capability layered on
pure composition** (composition itself never writes refs or commits; see
`composition.md`). The commit's bytes are a pure function of its declared
inputs: projected tree, target-ref state, holobranch name, source commit,
source description, message override, and identity/timestamps. Given identical
inputs, engines must produce **byte-identical commit objects** and therefore
identical commit hashes.

This spec captures the legacy JS engine's behavior (the conformance oracle)
exactly, with two deliberate desired-state divergences called out inline and
summarized under [Ported vs. desired state](#ported-vs-desired-state).

## Applies To

- `holo_projector::commit_projection` (Rust engine capability)
- `lib/Projection.js` `Projection#commit` — the conformance oracle, and the
  hybrid CLI's default `--commit-to` path (engine choice for commits is
  specced in `specs/behaviors/engine-selection.md` § Commit dispatch; the
  Rust path runs via the binding's `commitProjection` under
  `HOLO_ENGINE=rust`)
- `specs/behaviors/watch.md` — per-cycle commit inputs and the CAS/
  `REF_CONFLICT` behavior of committing watch cycles

## Details

### Inputs

| Input | Oracle (JS CLI) source | Rust engine |
| --- | --- | --- |
| Target ref (`commitTo`) | `--commit-to` | `commit_ref` parameter |
| Projected tree | the composed (and optionally lensed) output tree | `tree` parameter |
| Holobranch name | the projected holobranch | `holobranch` parameter |
| Source commit | `<ref>^{commit}` of the projected ref; omitted with `--no-commit-source-parent` | `source_commit` parameter |
| Source description | `git describe --always --tags <ref>` (ref mode) or the absolute work-tree path (working-tree mode), computed at commit time | `source` parameter (`Described { description }` / `WorkTree { path }`) |
| Message override | `--commit-message` | `message` parameter |
| Identity | ambient git config / `GIT_AUTHOR_*` + `GIT_COMMITTER_*` env | explicit signatures → repo config (incl. env) → `holo-tree` fallback |

The **source description is host-supplied, never engine-computed**: `git
describe` output depends on repository tag state and on git's hash-abbreviation
algorithm, and reproducing that algorithm in a second git implementation is a
determinism hazard. The engine treats the description as an opaque string; the
host (the CLI) computes it exactly as the oracle does.

### Target ref normalization

Exact port of the oracle's rule:

| `commitTo` value | Normalized target |
| --- | --- |
| `HEAD` | `HEAD`, **dereferenced through symbolic refs** at resolution/update time — the branch HEAD points at is what advances (matching `git update-ref HEAD`); a detached HEAD advances itself |
| starts with `refs/` | unchanged |
| anything else — including names containing `/` (e.g. `holo/projected` → `refs/heads/holo/projected`) | `refs/heads/<name>` |

### Parents

1. **First parent** — the normalized ref's current value (symbolic refs
   followed). When the ref does not resolve (missing, or unborn `HEAD`), an
   **init commit** is created and becomes the first parent instead:
   - tree: the empty tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`)
   - parents: none
   - message: `↥ initialized <holobranch>` + trailing newline
   - identity: same resolution as the projection commit

   The target ref never points at the init commit — it advances directly to
   the projection commit; the init commit exists only as its first parent.
2. **Second parent** — the source commit, when supplied. Included in **both**
   ref mode and working-tree mode.

### Message

Default message, exact bytes (`<from>` = the source description in ref mode,
the work-tree path in working-tree mode; `\n` line endings throughout):

```
☀ projected <holobranch> from <from>

<trailers>
```

Trailers, one per line, `:` separator, **fixed order**:

| # | Trailer | Included when |
| --- | --- | --- |
| 1 | `Source-holobranch: <holobranch>` | always |
| 2 | `Source-commit: <full 40-hex source commit>` | ref mode **and** a source commit was supplied |
| 3 | `Source: <source description>` | ref mode |

Working-tree mode therefore carries only `Source-holobranch` — the trailer
gate is the mode, not data availability (oracle quirk, ported).

- The stored message gains **exactly one trailing newline when it lacks one**
  (the oracle inherits this from `git commit-tree -m`, which appends `\n` only
  if absent; a message already ending in `\n` — even several — is stored
  verbatim). Ported exactly.
- A **message override replaces the entire message**: no default subject and
  **no trailers** (oracle quirk, ported). Parents are unaffected. The
  trailing-newline rule still applies.

### Ref advance

- The oracle performs a blind `git update-ref <ref> <commit>`.
- **Desired-state divergence (deliberate):** the Rust engine advances with a
  **compare-and-swap** on the ancestor it observed when resolving the first
  parent. A concurrent writer that moved the ref mid-projection surfaces as a
  structured `REF_CONFLICT` error (`specs/api/errors.md`) instead of being
  clobbered. When the ref did not exist at resolution time, the advance is
  unconditional (create); the create-create race window is accepted — it is
  no worse than the oracle's behavior in every case.
- Reflog contents are **not contractual** (engines may stamp different reflog
  identities/messages); only the ref's target and the commit bytes are.

### Return value

The new projection commit's id. Hosts that requested a commit substitute it
for the tree hash as the projection's output (the oracle's `projectBranch`
returns the commit hash when `commitTo` is set).

### Ported vs. desired state

Everything above is a pure port of the oracle, including its quirks (message
override drops trailers; working-tree mode embeds a machine-specific absolute
path in the message and drops the `Source*` trailers; the init commit is
re-created — at the same hash under pinned identity — whenever the ref is
absent). Exactly two deliberate divergences:

1. **CAS ref advance** (above) — structured `REF_CONFLICT` instead of blind
   last-writer-wins.
2. **First-parent resolution reads the ref directly** (following symbolic
   refs) rather than `git rev-parse <ref>`. For branch refs — the only valid
   projection targets — the two are identical; a `commitTo` ref pointing at
   an annotated tag would give the oracle the unpeeled tag id as first parent
   (a broken commit), where the Rust engine uses the ref's raw target the same
   way. No behavioral difference for commit-valued refs.

## Conformance fixtures

Byte-for-byte oracle captures under pinned identity (`Holo Author
<author@example.com> 1700000000 +0000` / `Holo Committer
<committer@example.com> 1700000001 +0000`) on a deterministic fixture repo
(source commit `1b05a93b…`, projected tree `cd141f02…`, describe `1b05a93`):

| Case | Oracle commit |
| --- | --- |
| Ref absent → init (`8a3bd1d9…`) + projection commit | `4ed3a757…` |
| Ref exists → previous projection commit as first parent | `a7f4efd5…` |
| Message override (trailers dropped) | `2d176173…` |
| No source commit (single parent, no `Source-commit`) | `91a5b430…` |
| Bare ref name (`projected-bare` → `refs/heads/projected-bare`) | `4ed3a757…` |

The Rust engine must reproduce these hashes from the same inputs. The parity
tests (with the capture procedure documented alongside) live in
`holo-projector/tests/commit.rs`.

## Principles

**Inherited** — from [`principles.md`](../principles.md):

- [Composition is pure; side effects live at the edges](../principles.md#composition-is-pure-side-effects-live-at-the-edges) —
  this spec *is* one of those edges: commit creation is layered around
  `project_branch`, never folded into it.
- [The legacy engine is the conformance oracle](../principles.md#the-legacy-engine-is-the-conformance-oracle) —
  quirks are ported first (trailer gating, override-drops-trailers, trailing
  newline); the two desired-state changes are declared here, not slipped in.
- [Determinism is the product](../principles.md#determinism-is-the-product) —
  commit bytes are a pure function of declared inputs; nothing the engine
  derives from environment (clock, cwd, tag state) may leak into them.
- [Never abort a host process](../principles.md#never-abort-a-host-process) —
  the concurrency failure is a stable, matchable `REF_CONFLICT`, not a panic
  or a clobber.

**Local:**

- **Provenance strings are inputs, not derivations.** Any human-readable
  provenance embedded in commit bytes (the describe string, the work-tree
  path) is supplied by the host, never computed inside the engine. If the
  engine computed it, two engines with different derivation details would
  produce different bytes from the same logical state — the description would
  become an undeclared input.
