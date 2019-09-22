# hologit-action
A GitHub action for hologit


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
    - name: Project emergence holobranches
      uses: jarvus/hologit-action@v1
      with:
        projections:
          - holobranch: emergence-skeleton
            commit-to: emergence/skeleton/v1 # TODO: extract 'v1' from pushed branch
          - holobranch: emergence-layer
            commit-to: emergence/layer/v1 # TODO: extract 'v1' from pushed branch
    - name: Project docs holobranches
      uses: jarvus/hologit-action@v1
      with:
        projections:
          - holobranch: docs
            commit-to: # TODO: add support for multiple commit-to args?
            - docs/v1 # TODO: extract 'v1' from pushed branch
            - gh-pages
  ```
