# hologit-projector-action

A GitHub action for projecting holobranches with hologit

## Roadmap

- [X] Convert to JavaScript action
- [ ] Use hologit to project release branch with node_modules integrated
- [ ] Patch hologit to handle generating empty initial commit parent for new commit-to ref
- [ ] Update docs/usage/examples

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
          - holobranch: emergence-layer
            commit-to: emergence/layer/${{steps.get-release-name.outputs.result}}
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
