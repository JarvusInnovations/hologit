# Repository Setup

This guide walks you through setting up a repository to use hologit, including initial configuration and common patterns.

## Basic Setup

### 1. Initialize Configuration

Create the basic hologit configuration:

```bash
git holo init
```

This creates `.holo/config.toml` with a basic configuration:

```toml
[holo]
name = "your-repo-name"
```

The `name` field is used as the default [holosource](./holosources.md) name when referencing content from the repository itself.

### 2. Directory Structure

A typical hologit-enabled repository has this structure:

```
.holo/
├── config.toml              # Main configuration
├── sources/                 # Holosource configurations
│   └── example-source.toml
├── branches/               # Holobranch configurations
│   └── example-branch/
│       └── mapping.toml
└── lenses/                # Hololens configurations
    └── example-lens.toml
```

### 3. Git Configuration

Add `.holo/` to your repository:

```bash
git add .holo/
git commit -m "Initialize hologit configuration"
```

## Advanced Configuration

### Environment Variables

Configure default behaviors through environment variables:

```bash
# Always fetch latest from specific sources
export HOLO_FETCH="source1:source2"

# Override source configurations
export HOLO_SOURCE_EXAMPLE="https://github.com/org/repo#branch"
```

### Source Configuration

Define external sources in `.holo/sources/`:

```toml
# .holo/sources/framework.toml
[holosource]
url = "https://github.com/example/framework"
ref = "refs/heads/develop"

# Optional: project a specific holobranch
[holosource.project]
holobranch = "dist"
```

### Branch Configuration

Define holobranches in `.holo/branches/`:

```toml
# .holo/branches/release.toml
[holobranch]
lens = true  # enable lensing by default
```

### Lens Configuration

Define lenses in `.holo/lenses/`:

```toml
# .holo/lenses/babel.toml
[hololens]
package = "example/babel-lens"

[hololens.input]
root = "src"
files = ["**/*.js"]

[hololens.output]
root = "dist"
merge = "overlay"
```

## Common Patterns

### Development Setup

1. Initialize repository:

   ```bash
   git init my-project
   cd my-project
   git holo init
   ```

2. Add source dependencies:

   ```bash
   git holo source create https://github.com/example/framework
   ```

3. Create development holobranch:

   ```bash
   git holo branch create development
   ```

### CI/CD Setup

1. Configure GitHub Action:

   ```yaml
   name: Project Holobranch

   on:
     push:
       branches: [ main ]

   jobs:
     project:
       runs-on: ubuntu-latest
       steps:
       - uses: actions/checkout@v3
        - uses: JarvusInnovations/hologit@actions/projector/v1
        with:
            holobranch: static-website
            commit-to: gh-pages
   ```

2. Enable branch protection rules
3. Configure deployment triggers

## Best Practices

### Version Control

- Commit `.holo/` directory
- Use `.gitignore` for temporary files
- Document source dependencies

### Organization

- Use consistent naming conventions
- Keep lens configurations modular

### Security

- Review source code before including

### Performance

- Use specific file patterns

## Next Steps

- Learn about [holosources](./holosources.md)
- Explore [holobranches](./holobranches.md)
- Understand [hololenses](./hololenses.md)
- Set up [workflows](../workflows/README.md)
