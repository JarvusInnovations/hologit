# hologit

**Hologit** is a universal tool for assembling software. It lives inside your project's git repository and enables you to define virtual "holobranches" that can be continuously and efficiently "projected" from a source branch. The projection process handles combining code from remote sources ("compositing") and executing build tools on the result ("lensing") to produce an output file tree.

**Compositing** offers deeper control over which files are pulled from a remote repository and where they are integrated than [git submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) alone, while being more dependable and tracable than language-specific package managers like [npm](https://www.npmjs.com/) and [composer](https://getcomposer.org/). Instead of copying and moving files around on disk, hologit takes a git-native approach to minimize disk activity by computing new git trees in memory. Computed trees may be written to disk later or used as input to another process without the overhead.

**Lensing** can execute any existing code or build tool consistently by leveraging [habitat](https://www.habitat.sh/) and using containers where necessary. However, it also opens the door to a new generation of git-native build tools that do as much of their work as possible in memory, reading and writing to git's object database instead of a working tree on disk.

## Quickstart

The guide will walk you through an illustrative minimal use of hologit to publish a GitHub Pages branch.

### Create a repository with some minimal code

To start this example, we'll use [the starter template from Bootstrap's *Getting Started* guide](https://getbootstrap.com/docs/4.2/getting-started/introduction/#starter-template) to create a website:

```console
$ git init holo-example
Initialized empty Git repository in /Users/chris/holo-example/.git/
$ cd holo-example/
$ curl -s https://raw.githubusercontent.com/hologit/examples/basic/index.html > index.html
$ git add index.html
$ git commit -m "Add Bootstrap's starter template as index.html"
[master (root-commit) 9fe77ec] Add Bootstrap's starter template as index.html
 1 file changed, 22 insertions(+)
 create mode 100644 index.html
```

### Install hologit

Hologit can be installed via habitat:

```console
$ hab pkg install -b jarvus/hologit
» Installing jarvus/hologit
☁ Determining latest version of jarvus/hologit in the 'stable' channel
→ Using jarvus/hologit/0.4.1/20181224022822
★ Install of jarvus/hologit/0.4.1/20181224022822 complete with 0 new packages installed.
» Binlinking git-holo from jarvus/hologit/0.4.1/20181224022822 into /bin
★ Binlinked git-holo from jarvus/hologit/0.4.1/20181224022822 to /bin/git-holo
```

or with npm:

```console
$ npm install -g hologit
/usr/local/bin/git-holo -> /usr/local/lib/node_modules/hologit/bin/cli.js
+ hologit@0.4.1
updated 1 package in 1.947s
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
[master 881b0b6] Initialize .holo/ configuration
 1 file changed, 2 insertions(+)
 create mode 100644 .holo/config.toml
```

To start, this configuration file only assigns a name for the code in the current source branch, which can be used later as an alternative to remote sources. The name `holo-example` was detected from the name of the repository's working tree, but could have been chosen by passing `--name ${my_project_name}` for the `init` command or just by editing the `./holo/config.toml` file later.

### Define a holobranch

A holobranch can be defined by creating a holobranch config file at `.holo/branches/${my_holobranch_name}.toml` or any number of holomapping config files within `.holo/branches/${my_holobranch_name}/**.toml`. Generate a minimal "passthrough" holobranch that will copy all files from the current source branch:

```console
$ git holo branch create --template=passthrough gh-pages
initialized .holo/branches/gh-pages/_holo-example.toml
$ cat cat .holo/branches/gh-pages/_holo-example.toml
[holomapping]
files = "**"
$ git commit -m "Initialize .holo/branches/gh-pages configuration"
[master 4b9aa68] Initialize .holo/branches/gh-pages configuration
 1 file changed, 2 insertions(+)
 create mode 100644 .holo/branches/gh-pages/_holo-example.toml
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

### Project holobranch for first time

With a holobranch defined with at least one holomapping, we have enough for our first tree projection:

```console
$ git holo project gh-pages
info: reading mappings from holobranch: gitDir=/Users/chris/holo-example/.git, ref=HEAD, workTree=false, name=gh-pages
info: compositing tree...
info: merging holo-example:{**} -> /
info: stripping .holo/ tree from output tree...
info: writing final output tree...
info: projection ready:
ff954bb0a1e4878db424cb1033a0c356dac8d350
$ git cat-file -t ff954bb0a1e4878db424cb1033a0c356dac8d350
tree
$ git ls-tree -r ff954bb0a1e4878db424cb1033a0c356dac8d350
100644 blob 8092fa2adb4a9a395ac291fbdc9717b68be669aa    index.html
```

The output of the `project` command seen above is the git hash of a **tree** object that has been generated, if needed, within your git repository's object database. This hash *does not* reference a commit object like most git hashes most commonly seen. A tree object is the main ingrediant of a commit obect: the tree represents a complete unique state of all the files and a commit attaches the tree to a point in your chain of commits with timestamp and authorship information.

A tree can be used directly:

```console
$ git archive --format=zip $(git holo project gh-pages) > website.zip
info: reading mappings from holobranch: gitDir=/Users/chris/Repositories/holo-example/.git, ref=HEAD, workTree=false, name=gh-pages
info: compositing tree...
info: merging holo-example:{**} -> /
info: stripping .holo/ tree from output tree...
info: writing final output tree...
info: projection ready:
$ unzip -l website.zip
Archive:  website.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
     1230  12-23-2018 20:32   index.html
---------                     -------
     1230                     1 file
```

or wrapped in a commit:

```console
$ git commit-tree -m "Update gh-pages"  $(git holo project gh-pages)
info: reading mappings from holobranch: gitDir=/Users/chris/Repositories/holo-example/.git, ref=HEAD, workTree=false, name=gh-pages
info: compositing tree...
info: merging holo-example:{**} -> /
info: stripping .holo/ tree from output tree...
info: writing final output tree...
info: projection ready:
846a551ce356d5fa4088e58b3ad0f0d05aa6d389
$ git cat-file -t 846a551ce356d5fa4088e58b3ad0f0d05aa6d389
commit
$ git cat-file -p 846a551ce356d5fa4088e58b3ad0f0d05aa6d389
tree ff954bb0a1e4878db424cb1033a0c356dac8d350
author Chris Alfano <chris@jarv.us> 1545615571 -0500
committer Chris Alfano <chris@jarv.us> 1545615571 -0500

Update gh-pages
```

With the `--commit-branch` option, you can commit the generated tree to a give branch and output the new commit's hash instead:

```console
$ git cat-file -p $(git holo project gh-pages --commit-branch=gh-pages)
info: reading mappings from holobranch: gitDir=/Users/chris/Repositories/holo-example/.git, ref=HEAD, workTree=false, name=gh-pages
info: compositing tree...
info: merging holo-example:{**} -> /
info: stripping .holo/ tree from output tree...
info: writing final output tree...
info: committed new tree to "gh-pages": 734f7dc034868af4e2bd23daf23e119faca1e0b8
info: projection ready:
tree ff954bb0a1e4878db424cb1033a0c356dac8d350
author Chris Alfano <chris@jarv.us> 1545616786 -0500
committer Chris Alfano <chris@jarv.us> 1545616786 -0500

Projected gh-pages from 4b9aa68
```

### Merge external code via a holosource

The first step to using external code in your projections is defining a holosource:

```console
$ git holo source create https://github.com/twbs/bootstrap --ref=v4.2.1
info: listing https://github.com/twbs/bootstrap#v4.2.1
info: fetching https://github.com/twbs/bootstrap#refs/tags/v4.2.1@9e4e94747bd698f4f61d48ed54c9c6d4d199bd32
fetched https://github.com/twbs/bootstrap#refs/tags/v4.2.1@9e4e94747bd698f4f61d48ed54c9c6d4d199bd32
initialized .holo/sources/bootstrap.toml
$ cat .holo/sources/bootstrap.toml
[holosource]
url = "https://github.com/twbs/bootstrap"
ref = "refs/tags/v4.2.1"

$ git commit -m "Initialize .holo/sources/bootstrap configuration"
[master 64ef9fc] Initialize .holo/sources/bootstrap configuration
 1 file changed, 3 insertions(+)
 create mode 100644 .holo/sources/bootstrap.toml
```

Now this source can be referenced in holobranch mappings:

```console
$ cat > .holo/branches/gh-pages/css/_bootstrap.toml <<- END_OF_TOML
[holomapping]
root = "dist/css"
files = "*.min.css"
END_OF_TOML
$ cat > .holo/branches/gh-pages/js/_bootstrap.toml <<- END_OF_TOML
[holomapping]
root = "dist/js"
files = "*.min.js"
END_OF_TOML
```

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
