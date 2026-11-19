# Hololenses

Hololenses are transformation tools that process content during holobranch projection. They enable automated build steps, code generation, and other transformations to be applied consistently.

## Core Concepts

### What is a Hololens?

A hololens is:

- A configured transformation tool
- Executed during holobranch projection
- Takes a Git tree as input
- Produces a new Git tree as output
- Implemented as a container or Habitat package

### How Lenses Work

1. Input tree is prepared based on lens configuration
2. Lens executable/container processes the tree
3. Output tree is integrated back into projection
4. Results are cached based on input content and lens version

## Types of Lenses

### Container-Based Lenses

Use Docker containers for transformation:

```toml
# .holo/lenses/babel.toml
[hololens]
container = "babel-lens:latest"

[hololens.input]
root = "src"
files = ["**/*.js"]

[hololens.output]
root = "dist"
merge = "overlay"
```

### Habitat Package Lenses

Use Habitat packages for transformation:

```toml
# .holo/lenses/sass.toml
[hololens]
package = "example/sass-lens"
command = "lens-tree {{ input }}"

[hololens.input]
files = ["**/*.scss"]
```

## Configuration

### Basic Structure

```toml
[hololens]
package = "example/lens"    # or container = "image:tag"

[hololens.input]
root = "src"               # source directory
files = ["**"]            # files to process

[hololens.output]
root = "dist"             # output directory
merge = "overlay"         # merge strategy
```

### Input Configuration

Control what content the lens processes:

```toml
[hololens.input]
root = "src"              # base directory
files = [
    "**/*.js",           # include JS files
    "!**/*.test.js"      # exclude test files
]
```

### Output Configuration

Control how results are integrated:

```toml
[hololens.output]
root = "dist"             # output directory
merge = "overlay"         # merge strategy: overlay, replace
```

## Common Lenses

### Babel (JavaScript Transformation)

```toml
[hololens]
container = "babel-lens:latest"

[hololens.input]
files = ["**/*.js"]
```

### SASS (CSS Preprocessing)

```toml
[hololens]
package = "example/sass-lens"

[hololens.input]
files = ["**/*.scss"]
```

### TypeScript Compilation

```toml
[hololens]
container = "typescript:latest"

[hololens.input]
files = ["**/*.ts"]
```

## Creating Custom Lenses

### Container Lens

1. Create Dockerfile:

   ```dockerfile
   FROM node:alpine
   WORKDIR /lens
   COPY process.js .
   ENTRYPOINT ["node", "process.js"]
   ```

2. Implement processing:

   ```javascript
   // process.js
   async function processTree(inputHash) {
     // Process input tree
     // Return output tree hash
   }
   ```

### Habitat Package Lens

1. Create plan:

   ```bash
   pkg_name=my-lens
   pkg_origin=example
   pkg_version="0.1.0"
   ```

2. Implement handler:

   ```bash
   #!/bin/bash
   input_tree="$1"
   # Process tree
   echo "$output_tree"
   ```

## Best Practices

### Performance

- Process only necessary files
- Use efficient transformations
- Enable appropriate caching

### Reliability

- Version lock containers/packages
- Handle errors gracefully
- Validate input/output

### Security

- Review lens code carefully
- Use trusted sources

## Troubleshooting

### Common Issues

1. **Lens Not Running**
   - Check container/package availability
   - Verify configuration syntax
   - Check execution permissions

2. **Unexpected Output**
   - Review input patterns
   - Check transformation logic
   - Verify merge strategy

### Debugging

```bash
# Enable debug output
DEBUG=1 git holo project branch-name

# Examine lens configuration
git holo lens list

# Test lens directly
git holo lens exec lens-name
```

## Next Steps

- Learn about [holoreactors](./holoreactors.md)
- Explore [workflows](../workflows/README.md)
