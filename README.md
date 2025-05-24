# hologit

A Git-native framework for declarative code automation that makes it simple to combine code from multiple sources and apply transformations efficiently.

## Overview

Hologit enables you to define virtual "holobranches" within your Git repository that can:

1. Mix together content from:
   - The host branch
   - Other repositories/branches
   - Generated/transformed content

2. Apply transformations through "hololenses" using:
   - Docker containers
   - Chef Habitat packages

3. Project changes efficiently by:
   - Computing new git trees in memory
   - Caching results based on content
   - ~~Watching for live updates~~ *Coming Soon*

## Key Concepts

### Holobranches

A holobranch is a virtual branch defined in `.holo/branches/` that specifies:

- What content to include from which sources
- How to transform that content through lenses
- Where the content should be placed in the output tree

Unlike regular Git branches, holobranches are computed on-demand and can mix content from multiple sources while maintaining clean history.

### Holosources

Sources let you pull in code from:

- Other repositories via Git submodules
- Other branches in the same repository
- Remote Git repositories
- Output from local or remote holobranches

Sources are configured in `.holo/sources/` and can be referenced by holobranches to include specific files or directories.

### Hololenses

Lenses are transformations that can be applied to source content through:

- Docker containers that process input trees
- Habitat packages that provide build tools

Lenses are configured in `.holo/lenses/` and can be chained together to form complex build pipelines.

## Getting Started

1. Initialize hologit configuration:

```bash
git holo init
```

2. Create a holobranch:

```bash
git holo branch create my-branch
```

3. Add a source:

```bash
git holo source create https://github.com/example/repo
```

4. Project your holobranch:

```bash
git holo project my-branch
```

See the [Installation Guide](docs/grand-tour/installation.md) and [Grand Tour](docs/grand-tour/README.md) for detailed setup and usage instructions.

## Key Features

- **Git-native**: Works directly with Git's object database for maximum efficiency
- **Content-based caching**: Automatically caches build results based on input content, optionally sharing with other users and CI/CD via the same Git server hosting your project
- **Declarative configuration**: Define complex automation workflows in TOML files
- ~~**Live updates**: Watch mode for continuous projection of changes~~ *Coming Soon*
- **GitHub Action**: Materialize holobranches to real branches in CI/CD
- **Flexible transformations**: Use any build tool through containers or packages

## Use Cases

- **Monorepo Management**: Combine code from multiple repositories while maintaining clean history
- **Build Automation**: Create efficient, reproducible build pipelines
- **Documentation**: Generate and publish documentation from multiple sources
- **Deployment**: Prepare deployment artifacts with consistent transformations
- **Code Generation**: Automate code generation and transformation workflows

## Documentation

- [Installation Guide](docs/grand-tour/installation.md)
- [Repository Setup](docs/grand-tour/repository-setup.md)
- [Working with Sources](docs/workflows/work-on-sources.md)
- [Holobranches Guide](docs/grand-tour/holobranches.md)
- [Hololenses Guide](docs/grand-tour/hololenses.md)
- [Holoreactors Guide](docs/grand-tour/holoreactors.md)

## License

This project is [free and open source](https://www.fsf.org/about/what-is-free-software) software.
