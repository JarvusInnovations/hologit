# hologit-projector-action

A GitHub action for projecting holobranches with hologit

## Roadmap

- [X] Convert to JavaScript action
- [ ] Restore defaulting of git author
- [ ] Use hologit to project `action-projector` release holobranch with node_modules integrated with source merged into `actions/` of main source tree
- [X] Patch hologit to handle generating empty initial commit parent for new commit-to ref
- [ ] Update docs/usage/examples
- [ ] Make push optional so non-release branches can test builds
  - project all branches, and then only push refs and tags after everything succeeds

## Inputs

- `holobranch` (required): Name of holobranch to project
- `ref`: Name of branch/ref to read source tree from
- `fetch`: Whether to fetch the configured ref (default: `true`)
- `commit-to`: Name of branch/ref to optionally commit result to
- `commit-message`: Custom commit message to use when committing (requires `commit-to`)
- `commit-source-parent`: Include the source commit as a second parent in the projection commit (default: `true`)
- `cache`: Whether to use cache (default: `true`)

## Outputs

- `tree`: Tree hash for last projection
- `commit`: Commit hash for last projection (if `commit-to` is configured)

## Usage (mockup)

```yaml
name: Project holobranchs

on:
  push:
    branches:
      releases/*

jobs:
  project:

    runs-on: ubuntu-latest

    steps:
    - id: get-release-name
      name: Get release name with github-script
      uses: actions/github-script@0.2.0
      with:
        github-token: ${{github.token}}
        script: return context.ref.replace(/^refs\/heads\/releases\//, '')
    - name: Project emergence holobranches
      uses: jarvus/hologit-action@v1
      with:
        projections:
          - holobranch: emergence-skeleton
            commit-to: emergence/skeleton/${{steps.get-release-name.outputs.result}}
            commit-message: "Deploy skeleton v${{steps.get-release-name.outputs.result}}"
          - holobranch: emergence-layer
            commit-to: emergence/layer/${{steps.get-release-name.outputs.result}}
            commit-message: "Deploy layer v${{steps.get-release-name.outputs.result}}"
    - name: Project docs holobranches
      uses: jarvus/hologit-action@v1
      with:
        projections:
          - holobranch: docs
            commit-to:
            - docs/${{steps.get-release-name.outputs.result}}
            - gh-pages # TODO: make conditional on release name matching current major version
  ```

*Note: this example won't totally work yet, pending actions/github-script#7*

## Testing

### Build container

```bash
docker build --build-arg HAB_LICENSE=accept-no-persist -t jarvus/hologit-actions-projector:v1 .
docker push jarvus/hologit-actions-projector:v1
```

### Run container with shell

```bash
docker run -it --rm --entrypoint /bin/bash hologit-projector-action
```
