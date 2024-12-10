# Installation Guide

Hologit is a Git extension that requires Git >= 2.8.0 and can be installed through multiple package managers.

## System Requirements

- Git >= 2.8.0
- Node.js >= 16 (if installing via npm)
- Docker (optional, for container-based lenses)
- Habitat (optional, for habitat-based lenses)

## Installation Methods

### Via Habitat (Recommended for Linux)

[Habitat](https://www.habitat.sh/) provides the most integrated experience for Linux environments:

```bash
hab pkg install -b jarvus/hologit
```

This will:

1. Install the latest stable version of hologit
2. Create the necessary binlinks
3. Set up the habitat studio environment

### Via NPM (Recommended for macOS)

For macOS and other environments, installing via [npm](https://www.npmjs.com/) is recommended:

```bash
# Verify requirements
git --version  # should be >= 2.8.0
node --version # should be >= 16

# Install hologit globally
npm install -g hologit
```

This will:

1. Install the hologit package globally
2. Create a git-holo command in your PATH
3. Enable using hologit as a Git extension

## Optional Components

### Watchman for Live Updates

[Watchman](https://facebook.github.io/watchman/) enables live updates when working with holobranches. While this feature is still in development, installing Watchman is recommended for future functionality.

#### Via Habitat (Linux)

```bash
# Install watchman
hab pkg install -b jarvus/watchman

# Create required directory
mkdir -m 777 -p /hab/svc/watchman/var
```

#### Via Homebrew (macOS)

```bash
brew install watchman
```

### Docker for Container Lenses

If you plan to use container-based lenses:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop) (macOS/Windows) or Docker Engine (Linux)
2. Ensure the Docker daemon is running
3. Test with: `docker run hello-world`

### Habitat for Package Lenses

If you plan to use habitat-based lenses:

1. Install [Habitat](https://www.habitat.sh/docs/install-habitat/)
2. Configure hab studio:

   ```bash
   hab cli setup
   ```

## Verifying Installation

After installation, verify hologit is working:

```bash
# Check version
git holo version

# View help
git holo help
```

## Upgrading

### Via Habitat

```bash
hab pkg install -b jarvus/hologit
```

### Via NPM

```bash
npm update -g hologit
```

## Troubleshooting

### Common Issues

1. **git-holo command not found**
   - Ensure the installation directory is in your PATH
   - Try running `which git-holo` to locate the command

2. **Permission errors with Habitat**
   - Ensure proper permissions on /hab directory
   - Try running with sudo if needed

3. **Node version conflicts**
   - Use nvm to manage Node versions
   - Ensure global npm permissions are correct

### Getting Help

- File issues on [GitHub](https://github.com/JarvusInnovations/hologit/issues)
- Check the [documentation](https://github.com/JarvusInnovations/hologit/tree/master/docs)
- Join the community discussions
