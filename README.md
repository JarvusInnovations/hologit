# git-holobranch

Code virtual git branches that get assembled automatically from any number of source branches and remote repositories!

## Holo sources

- `.holo/sources/[myorg/mysource]`: Sorted git ini file defining a source

## Holo mounts

- `.holo/mounts[/mount/path]/[mymount]`: Sorted git ini file defining a mount

## Holo hooks

- `.holo/hooks[/mount/path]/[myhook].[pre-project|post-project]`: A hook run when a source changes at an optional source subpath



Shell scripts within the XXXXX tree can be named in the format `myscript.[hook]` where `[hook]` is one of:

- `pre-project`: Can modify a tree before projection, including holomounts/holosources
- `post-project`: Can modify a tree after projection

## Examples

### Example 1: One branch with embedded holo data

```bash
git holobranch project master production
```

### Example 2: Seperate code and holo data branches

Given a repository with 3 exististing branches:

- `master`: The source code for your application
- `holo/workspace`: A holo-only branch for projecting master to a developer workspace
- `holo/production`: A holo-only branch for projecting master to production

```bash
git holobranch project master holo/workspace workspace
git holobranch project master holo/production production
```


## Random thoughts / questions

### Shorter/broader name -- `git-holo`?

Then the command `git holobranch project [source-branch] [holo-branch]` might just be `git holo branch [source-branch] [holo-branch]`