# Holobranches

Holobranches are virtual branches that combine content from multiple sources. They exist as configurations within your Git repository and can be projected into real Git trees on demand.

## Core Concepts

### What is a Holobranch?

A holobranch is:

- A virtual branch defined in `.holo/branches/`
- Composed of mappings that specify source content
- Optionally transformed by lenses
- Projected into a Git tree on demand

Unlike regular Git branches, holobranches:

- Don't store content directly
- Are computed when projected
- Can mix content from multiple sources
- Can apply transformations automatically

## Configuration

### Basic Structure

```toml
# .holo/branches/example.toml
[holobranch]
lens = true  # enable lensing by default
```

### Mapping Files

Mappings define what content goes where:

```toml
# .holo/branches/example/_static.toml
[holomapping]
holosource = "framework"   # source to pull from
files = "**"                # files to include
```

### Directory Organization

```
.holo/branches/example/
├── _app.toml              # maps to root (underscore prefix)
├── static.toml            # maps to /static/
└── api/
    └── _routes.toml       # maps to /api/
```

## Usage

### Creating Holobranches

```bash
# Create new holobranch
git holo branch create example

# Create with template
git holo branch create --template=static site
```

### Projecting Holobranches

```bash
# Project to tree
git holo project example

# Project to branch
git holo project example --commit-to=gh-pages

# Project with working changes
git holo project example --working
```

### Working with Projections

```bash
# Create archive
git archive --format=zip $(git holo project example) > output.zip
```

## Common Patterns

### Static Site

```toml
# .holo/branches/site/_framework.toml
[holomapping]
holosource = "framework"
files = ["**"]

# .holo/branches/site/_content.toml
[holomapping]
files = ["content/**"]
```

### API Documentation

```toml
# .holo/branches/docs/_api.toml
[holomapping]
holosource = "api"
files = ["docs/**"]
output = "api"

# .holo/branches/docs/_tutorials.toml
[holomapping]
files = ["tutorials/**"]
output = "guides"
```

## Best Practices

### Organization

- Use clear, descriptive names for holobranches
- Group related mappings in directories
- Document mapping purposes

### File Selection

- Be specific with file patterns
- Consider using `.gitignore` patterns
- Document excluded files

### Source Management

- Use specific source versions
- Document source dependencies
- Keep mappings modular

## Troubleshooting

### Common Issues

1. **Content Not Appearing**
   - Check file patterns
   - Verify source availability
   - Check mapping configuration

2. **Unexpected Content**
   - Review mapping configurations
   - Check for conflicting patterns

### Debugging

```bash
# Enable debug output
DEBUG=1 git holo project example

# Examine projection tree
git ls-tree -r $(git holo project example)

# Check mapping configuration
git holo branch list --verbose
```

## Next Steps

- Learn about [hololenses](./hololenses.md)
- Explore [workflows](../workflows/README.md)
- Set up [continuous integration](../workflows/ci.md)
