# hologit

**Hologit** is a universal tool for assembling software. It lives inside your project's git repository and enables you to define virtual "holobranches" that can be continuously and efficiently "projected" from a source branch. The projection process handles combining code from remote sources ("compositing") and executing build tools on the result ("lensing") to produce an output file tree.

**Compositing** offers deeper control over which files are pulled from a remote repository and where they are integrated than [git submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) alone, while being more dependable and tracable than language-specific package managers like [npm](https://www.npmjs.com/) and [composer](https://getcomposer.org/). Instead of copying and moving files around on disk, hologit takes a git-native approach to minimize disk activity by computing new git trees in memory. Computed trees may be written to disk later or used as input to another process without the overhead.

**Lensing** can execute any existing code or build tool consistently by leveraging [habitat](https://www.habitat.sh/) and using containers where necessary. However, it also opens the door to a new generation of git-native build tools that do as much of their work as possible in memory, reading and writing to git's object database instead of a working tree on disk.

## Quickstart

### Create a repository with some minimal code

To start this example, we'll use [the starter template from Bootstrap's *Getting Started* guide](https://getbootstrap.com/docs/4.2/getting-started/introduction/#starter-template) to create a website:

```console
$ git init holo-example
Initialized empty Git repository in /Users/chris/holo-example/.git/
$ cd holo-example/
$ curl -s https://raw.githubusercontent.com/hologit/examples/basic/index.html > index.html
$ git add index.html
$ git commit -m "Add Bootstrap's starter template as index.html"
[master (root-commit) 82a1a39] Add bootstrap's starter template as index.html
 1 file changed, 22 insertions(+)
 create mode 100644 index.html
```

### Install hologit

Hologit can be installed via habitat:

```console
$ hab pkg install -b jarvus/hologit
» Installing jarvus/hologit
☁ Determining latest version of jarvus/hologit in the 'stable' channel
→ Using jarvus/hologit/0.3.0/20181015020008
★ Install of jarvus/hologit/0.3.0/20181015020008 complete with 0 new packages installed.
» Binlinking git-holo from jarvus/hologit/0.3.0/20181015020008 into /bin
★ Binlinked git-holo from jarvus/hologit/0.3.0/20181015020008 to /bin/git-holo
```

or with npm:

```console
$ npm install -g hologit
# coming soon
```

### Initialize .holo/ configuration

Hologit configuration is stored under the `.holo/` tree at the root of a repository. Initialize it in each branch that will generate projections:

```console
$ git holo init
name=holo-example
initialized .holo/config.toml
$ cat .holo/config.toml
[holo]
name = "holo-example"
$ git commit -m "Initialize .holo/ configuration"
[master 3ae86bd] Initialize .holo/ configuration
 1 file changed, 2 insertions(+)
 create mode 100644 .holo/config.toml
```

To start, this configuration file only assigns a name for the code in the current source branch that can be used to reference it as a source for files when compositing a holobranch. The name `holo-example` was detected from the name of the repository's working tree, but could have been chosen by passing `--name ${my_project_name}` for the `init` command or just by editing the `./holo/config.toml` file later.

### Define and project a holobranch

A holobranch can be defined by creating a holobranch config file at `.holo/branches/${my_holobranch_name}.toml` or any number of holomapping config files within `.holo/branches/${my_holobranch_name}/**.toml`. Generate a minimal "passthrough" holobranch that will copy all files from the current source branch:

```console
$ git holo branch create --template=passthrough gh-pages
initialized .holo/branches/gh-pages/_holo-example.toml
$ cat cat .holo/branches/gh-pages/_holo-example.toml
[holomapping]
files = "**"
```

This defines a holobranch named `gh-pages` with all files from holosource `holo-example` matching the [glob pattern](https://github.com/isaacs/minimatch) `**` populating its root directory. There are several elements of convention on display here:

- The underscore prefixing the filename of`/_holo-example.toml` indicates that any files produced by the holomapping should be merged into the root directory of the projected holobranch.
  - If the filename were just `/holo-example.toml`, a subdirectory name `/holo-example/` would be created to contain all the files produced by the holomapping.
  - A holomapping config prefixed with an underscore could be named anything, all such holomappings at the same path will have their files merged to populate the directory.
- There are only two required configuration options for each holomapping:
  - `holosource`: The name of a configured holosource referencing a repository to pull files from
    - Ommitted in the generated holomapping config
    - Defaults to the name of the file with the `.toml` extension and any `_` prefix stripped
  - `files`: A string or array for strings containing [glob patterns](https://github.com/isaacs/minimatch) for matching or excluding files
    - A value of just `'**'`, as in the generated config, matches all files in the source

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
