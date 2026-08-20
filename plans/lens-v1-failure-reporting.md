---
status: planned
depends: []
specs: []
issues: [511]
---

# Plan: surface real lens failures on the v1 container transport

## Scope

Fix [#511](https://github.com/JarvusInnovations/hologit/issues/511): when a v1
(port-9000 git server) container lens job fails, `executeSpecForContainerV1`
currently throws the downstream `rev-parse <outputRef>^` git error (the
unadvanced input commit is parentless), masking the real build failure that was
relayed to stderr during the push. Detect the didn't-advance case directly and
throw a lens-job-failed error carrying a tail of the container's own output.

Out of scope: any change to the v2 (exec/stdio) path, which already reports
failures directly; retiring the v1 fallback entirely (that's
[#502](https://github.com/JarvusInnovations/hologit/issues/502)). No spec
change — the v1 transport is a legacy-unspecced path; the specced successor is
the v2 protocol (`specs/behaviors/lensing.md`), and this fix only improves v1's
diagnostics on its way out.

## Implements

No specs — legacy-path bugfix (see Scope). Tracked by issue #511.

## Approach

1. In `executeSpecForContainerV1` (`lib/Lens.js`): buffer the container output
   lines the push handler already receives (`$onStderr`) while continuing to
   relay them to stderr.
2. After the fetch, resolve `outputRef` itself and compare to the pushed input
   `commitHash` **before** the existing `^` parent check. Equal ⇒ the job never
   advanced `lens-input` ⇒ throw `lens job failed …` naming the container image
   and embedding the last ~15 buffered output lines, so the underlying build
   error is in the thrown error, not just somewhere above it in the log.
3. Keep the existing parent-mismatch check unchanged as the corruption guard
   for the advanced-but-wrong case.

## Validation

- [ ] A v1 lens whose build command exits non-zero surfaces `lens job failed`
      with the container's output tail (manual repro per #511's environment —
      requires docker + a v1 lens image)
- [ ] A successful v1 lens run is byte-identical in behavior (guard compares
      then falls through to the unchanged happy path)
- [ ] Existing CI suites pass unchanged (test, test-cli, test-action, test-rust)

## Risks / unknowns

- **No automated coverage of the v1 container path** — CI has no docker-lens
  fixture, so the failure branch is validated by manual repro + code review,
  not a regression test. Acceptable for a diagnostics-only change on a path
  being retired by #502.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
