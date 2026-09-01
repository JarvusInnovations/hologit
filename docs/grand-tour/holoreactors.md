# Holoreactors

*Note: Holoreactors are a planned feature. This documentation outlines the intended functionality.*

## Core Concepts

### What is a Holoreactor?

A holoreactor will be:

- A running service spawned from holobranch content
- Automatically updated when source content changes
- Designed for development servers and build watchers
- Implemented as a Habitat service or Docker container

### How Reactors Will Work

1. Monitor holobranch content for changes
2. Spawn/update services based on configuration
3. Provide feedback through logs/endpoints
4. Maintain state between updates

## Planned Configuration

### Basic Structure

```toml
# .holo/reactors/dev-server.toml
[holoreactor]
command = "npm start"
watch = true

[holoreactor.environment]
PORT = "3000"
NODE_ENV = "development"
```

### Watch Configuration

```toml
[holoreactor.watch]
paths = ["src/**"]        # files to watch
ignore = ["**/*.test.js"] # files to ignore
debounce = 1000          # wait time in ms
```

### Service Configuration

```toml
[holoreactor.service]
type = "node"            # service type
port = 3000             # exposed port
health = "/health"      # health check endpoint
```

## Planned Use Cases

### Development Server

```toml
[holoreactor]
command = "npm run dev"
watch = true

[holoreactor.environment]
PORT = "3000"
```

### Build Watcher

```toml
[holoreactor]
command = "npm run build:watch"

[holoreactor.watch]
paths = ["src/**"]
```

### Test Runner

```toml
[holoreactor]
command = "npm test"
watch = true

[holoreactor.watch]
paths = ["src/**", "tests/**"]
```

## Current Alternatives

While waiting for holoreactors, you can:

1. Use standard development servers:
   ```bash
   # In one terminal
   git holo project development --working

   # In another terminal
   cd dist/
   npm run dev
   ```

2. Use file watchers:
   ```bash
   # Watch for changes and project
   while true; do
     git holo project development --working
     sleep 5
   done
   ```

3. Use GitHub Actions for CI/CD:
   ```yaml
   name: Project & Deploy
   on: [push]
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
       - uses: actions/checkout@v3
       - uses: JarvusInnovations/hologit@actions/projector/v1
         with:
           holobranch: development
           commit-to: gh-pages
   ```

## Future Development

### Planned Features

1. **Service Management**
   - Automatic service spawning
   - Health monitoring
   - Log aggregation

2. **Change Detection**
   - Efficient file watching
   - Intelligent rebuilding
   - Cache management

3. **Development Tools**
   - Visual Studio Code integration
   - Browser-based management
   - Interactive debugging

### Getting Involved

While holoreactors are in development, you can:

1. Share use cases and requirements
2. Test early implementations
3. Contribute to the design discussion

## Next Steps

- Learn about current [workflows](../workflows/README.md)
- Explore [CI/CD integration](../workflows/ci-cd.md)
- Join the [community discussion](https://github.com/JarvusInnovations/hologit/discussions)
