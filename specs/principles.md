# Principles

Hologit's philosophy, written down as decisive rules. Each picks a side of a real trade-off so an implementer can resolve an unspecified case the way the project would. Feature specs reference these by anchor from their `## Principles` sections.

## Determinism is the product

A projection is a pure function of its inputs: the same source trees, config, and mappings must produce a **hash-identical** output tree — across runs, engine implementations, platform, and hologit versions. When a convenience and reproducibility conflict, reproducibility wins.

This rules out: iteration over unordered collections anywhere results can be order-sensitive (children live in `BTreeMap`, never `HashMap`); unstable topological sorts (Kahn's with a `VecDeque` preserving discovery order for unconstrained nodes); wall-clock time, randomness, or environment leaking into tree content.

> Why: consumers commit projected trees to real branches and diff them across runs (GitOps deploy pipelines, redaction mirrors). A hash that wobbles without an input change is indistinguishable from a corrupted pipeline.

## The legacy engine is the conformance oracle

During the Rust migration, the Node.js engine (`lib/`) defines correct behavior. A ported capability is done when it produces **hash-identical output** to the JS engine on the reference projections (see `behaviors/composition.md` § Conformance fixtures) — not when it "looks right."

Quirks get replicated first, changed second: if JS behavior seems wrong (e.g. minimatch's `**` matching zero segments differs from a Rust glob library's default), the Rust port reproduces the JS behavior, and any deliberate change goes through a spec amendment afterward. Never silently "fix" behavior mid-port.

## Never abort a host process

`holo-tree` and `holo-projector` are embedded libraries — consumed across FFI boundaries (napi, pyo3) by long-running host processes (API servers, daemons). A panic that crosses the FFI boundary aborts the host; that is a critical bug regardless of how violated the internal invariant is.

- Public-path code returns `Result`; `.unwrap()`/`.expect()` on invariants reachable from a public entry point is a defect.
- Errors must carry **stable, matchable discriminants** (error codes/kinds) that survive FFI as more than a prose string, so embedding consumers can map them onto typed errors without parsing `Display` output.

> Why: proven in production by the gitsheets spike — a violated invariant in `get_or_create_subtree` took down the entire Node process with an uncatchable abort (gitsheets `notes/holo-tree-findings.md` #1, #6).

## Git-native: no state outside the repository

All persistent state lives in git objects and refs — fetched sources under `refs/holo/source/...`, caches as refs/commits, projected outputs as trees and commits. No sidecar databases, lockfiles-as-state, or working-directory scratch state that a fresh clone wouldn't reproduce.

> Why: a bare clone of the repository is the complete system. This is what lets projections run identically in CI containers, on developer machines, and inside embedding libraries operating on bare repos.

## Rough edges get fixed upstream, not papered over in glue

When a consumer (a binding, gitsheets, a CLI layer) hits an ergonomic or correctness rough edge in a core crate, the fix lands in the core crate. Bindings stay thin marshalling shells; workaround code in a consumer is a signal of upstream debt, not a solution.

> Why: proven by the gitsheets spike protocol — every finding fixed upstream in holo-tree made every other present and future consumer better; the one smoothing the binding did locally (per-call `to_thread_local()`) is still flagged as debt.

## Composition is pure; side effects live at the edges

The composition core performs no network I/O, executes no containers, and writes no refs — it reads git objects and writes trees. Fetching sources, executing lenses, and creating/advancing projection commits are explicit capabilities layered *around* the pure core, never folded into it.

> Why: purity is what makes the core testable against hash-identity, embeddable in any host, and portable across engines. It also defines the migration seam: the pure core ported first precisely because it has no side-effecting entanglements.
