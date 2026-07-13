---
status: done
depends: [projector-napi-cli]
specs:
  - specs/architecture.md
  - specs/api/projector-napi.md
issues: [493]
pr: 503
---

# Establish the @hologit/holo-projector publication track

## Scope

Stand up the publication pipeline for the `holo-projector-napi` binding as the
scoped npm package **`@hologit/holo-projector`**, mirroring the proven
`holo-tree-napi` track end to end:

- **Packaging** — publishing fields in `holo-projector-napi/package.json`
  (optionalDependencies on the per-platform packages, `prepublishOnly` napi
  hook, version aligned to the `0.0.1` pre-bootstrap convention) plus the
  `npm/<triple>/` platform package manifests for the same six triples
  holo-tree ships.
- **Workflow** — `.github/workflows/holo-projector-napi.yml`: PR-triggered
  build verification of all six prebuilds, and publish via npm trusted
  publishing (OIDC, tokenless) on **`holo-projector-v*`** tags with the
  version stamped from the tag. Never a bare `v*` tag — it collides with the
  `hologit` JS release namespace and `publish-npm.yml`'s trigger.
- **Docs** — rewrite `holo-projector-napi/README.md` as the consumer-facing
  npm page (mirroring the holo-tree README structure), including the
  one-time trusted-publishing bootstrap procedure.
- **Spec amendments (same PR, spec-first)** — `specs/architecture.md`
  § Release tracks gains the `holo-projector-v*` track (and the component
  table/crate count catches up to the fourth crate);
  `specs/api/projector-napi.md` drops its "publication is deferred" language
  and absorbs the `LENS_*` error codes the crate already ships (drift from
  the lens-execution merge, surfaced because the npm README must document
  them).

**Out of scope:**

- **Pushing the first tag.** The packages must exist on npm before trusted
  publishing can be configured, so the first release requires the manual
  bootstrap documented in the README — recorded under Follow-ups with exact
  commands. Issue #493 stays open until the package actually publishes.
- **Wiring the CLI to prefer the published package** when the in-repo build
  is absent (#493's last bullet) — the CLI keeps loading the in-repo build
  via `npm run build:projector-addon` exactly as today.
- **Any binding source changes** — the watch-mode and lens-execution work
  just merged; this plan touches packaging, CI, and docs only.

## Implements

- `specs/architecture.md` § Release tracks — the third npm package track:
  `@hologit/holo-projector` on `holo-projector-v*` tags.
- `specs/api/projector-napi.md` § Notes (Packaging) — platform packages and
  the prefix-namespaced release tag track; § Error contract — the complete
  code table the published README documents.

## Approach

1. Amend the specs first (release-tracks row, packaging note, `LENS_*` code
   rows sourced from `holo_projector::Error::code()`).
2. `package.json`: version `0.0.1`, `optionalDependencies` pinning the six
   platform packages at `0.0.1`, `prepublishOnly: napi prepublish -t npm
   --skip-gh-release` — matching holo-tree field-for-field. npm skips
   unresolvable optionalDependencies (verified empirically; also how
   holo-tree's lock looked pre-bootstrap), so local `npm install` keeps
   working before the platform packages exist.
3. Generate `npm/<triple>/` manifests with `npx napi create-npm-dir -t .`
   (the triples are already declared), then align the generated manifests
   with holo-tree's committed ones.
4. `holo-projector-napi.yml`: copy `holo-tree-napi.yml`, swap the package
   name, tag prefix (`holo-projector-v*`), and paths filter (adding
   `holo-projector/**` — the binding's crate dependency chain includes both
   engine crates). Same six-target matrix (four native + musl-via-zig +
   darwin-x64 cross), same tag-stamped `npm version --no-git-tag-version` +
   `napi version` + optionalDependencies re-pin, same OIDC publish
   (`npm publish --provenance --access public`).
5. README rewrite mirroring holo-tree's: what it is, install, quick start
   (one-shot functions + `ProjectionSession`), error-code table, the
   release-build performance warning, engine-selection/embedding notes,
   release track, and the one-time bootstrap.
6. Prove the workflow by letting this PR's own `pull_request` trigger build
   all six targets (workflow_dispatch is unavailable until the file reaches
   the default branch). No tag is pushed.

## Validation

- [x] `holo-projector-napi` workflow green on this PR: all six targets build,
  native targets smoke-test (`npm test`) against the built addon
  (run 29217354840; the publish job correctly skipped — no tag)
- [x] `npm run build:projector-addon` + `npm --prefix holo-projector-napi test`
  pass locally (18/18) — the CLI's in-repo load path is unchanged
- [x] Root `npm test` (jest) passes (110/110; `test-cli` CI green too)
- [x] `npm pack --dry-run` on the main package ships exactly
  `index.js`/`index.d.ts` (+ `package.json`/`README.md`); each
  `npm/<triple>/` manifest matches holo-tree's shape (os/cpu/libc, `main`
  and `files` naming the `.node`)
- [x] `specs/architecture.md` § Release tracks lists the
  `holo-projector-v*` track; `specs/api/projector-napi.md` documents the
  full error-code table (incl. `SOURCE_FETCH`, `LENS_*`) with no
  "publication is deferred" residue
- [x] README covers install, quick start, error codes, the debug-vs-release
  warning, the release track, and the one-time bootstrap procedure

## Risks / unknowns

- **Unpublished optionalDependencies** — npm must tolerate the six platform
  packages 404ing until bootstrap. Verified: npm v11 skips unresolvable
  optional deps (exit 0, omitted from the lock), and holo-tree shipped in
  exactly this state between its packaging commit and first publish.
- **Workflow can't be dispatch-tested pre-merge** — `workflow_dispatch` only
  works once the file is on the default branch; the `pull_request` trigger
  on this PR is the build-verification evidence instead.
- **Trusted publishing is per-package** — all seven packages (main + six
  platform) need the one-time manual publish + trusted-publisher
  configuration before the tag-driven flow works; a tag pushed before that
  fails at `npm publish`. Mitigated by documenting the bootstrap in the
  README and Follow-ups.

## Notes

- **`node --test test/*.mjs` broke on the windows-latest runner** — pwsh
  doesn't expand globs, so node got the literal pattern. Fixed by
  enumerating the test files like holo-tree's script does (which also keeps
  dodging node 22.22.x's broken `node --test <dir>` form, the reason #492
  chose the glob). If a new test file is added, the script must list it.
- **npm skips unresolvable optionalDependencies** (verified on npm 11:
  `npm install` exits 0 and omits them from the lock), so the six
  hand-pinned platform packages are safe to commit before they exist — the
  same pre-bootstrap state holo-tree shipped in.
- The six-target matrix follows holo-tree's *current* workflow, not the
  older three-target description in CLAUDE.md/docs — the binding's
  package.json already declared all six triples.
- `workflow_dispatch` on a new workflow file is unusable until the file
  reaches the default branch; the PR's own `pull_request` trigger served as
  build verification instead.
- The workflow's version stamping (`npm version` + `napi version`) leaves
  the committed manifests at `0.0.1` forever; the `holo-projector-v*` tag is
  the only version authority.

## Follow-ups

- Tracked as: **first release awaits the one-time npm bootstrap** (issue
  [#493](https://github.com/JarvusInnovations/hologit/issues/493) stays open
  until the package publishes). Steps: (1) download the `bindings-*`
  artifacts from a green `holo-projector-napi` run; (2) as an `@hologit` org
  member: `cd holo-projector-napi && npm install && npx napi artifacts --dir
  <artifacts-dir>`, then `for d in npm/*/ ; do ( cd "$d" && npm publish
  --access public ); done`, then `npm publish --access public
  --ignore-scripts`; (3) configure a trusted publisher (repo
  `JarvusInnovations/hologit`, workflow `holo-projector-napi.yml`) for each
  of the 7 packages on npmjs.com; (4) from master, `git tag
  holo-projector-v0.1.0 && git push origin holo-projector-v0.1.0` — never a
  bare `v*`.
- Tracked as: wiring the CLI to prefer the published package when the
  in-repo build is absent remains with issue
  [#493](https://github.com/JarvusInnovations/hologit/issues/493) (its last
  bullet) — deliberately out of this plan's scope.
