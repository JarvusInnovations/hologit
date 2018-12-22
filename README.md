# hologit

**Hologit** is a universal tool for assembling software that lives inside your project's git repository. Virtual branches, defined through simple configuration files, can be continuously and efficiently "projected" from a source branch. The projection process handles combining code from remote sources ("compositing") and executing build tools on the result ("lensing") to produce an output file tree.

**Compositing** offers deeper control over which files are pulled from a remote repository and where they are integrated than [git submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) alone, while being more dependable and tracable than language-specific package managers like [npm](https://www.npmjs.com/) and [composer](https://getcomposer.org/). Instead of copying and moving files around on disk, hologit takes a git-native approach to minimize disk activity by computing new git trees in memory. Computed trees may be written to disk later or used as input to another process without the overhead.

**Lensing** can execute any existing code or build tool consistently by leveraging [habitat](https://www.habitat.sh/) and using containers where necessary. However, it also opens the door to a new generation of git-native build tools that do as much of their work as possible in memory, reading and writing to git's object database instead of a working tree on disk.

## Quickstart

### Define and project a holo branch

- A static HTML file with bootstrap/jquery CDN links

### Merge external code via a holo source

- Pull bootstrap and jquery sources

### Assemble the complete source code via a holo lens

- Apply sass compilation and compression via generic lenses

### Make use of a projected tree

- Archive tree-ish
- Write to a real branch
- Push to github gh-pages

## Advanced Usage

### Overlay a project

### Build new holo lenses

## Roadmap

## Reference

## TODO

- [ ] Have `project` fetch and read source HEAD if no submodule commit is found
- [ ] Refactor `source add` and `source fetch` to use common code, leave things in same state
