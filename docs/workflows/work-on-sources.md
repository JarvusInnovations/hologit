# Work on Sources

There are currently two supported methods for working on sources concurrently with working on your project:

- Environmental source overrides
- Source submodule checkouts

Of the two, environmental source overrides are the more mature feature and recommended for now.

## Method 1: Environmental Source Overrides (Recommended)

Environment variables based on the names of sources can be set to override their URL, ref, and optionally holobranch:

```bash
export HOLO_SOURCE_<SOURCE_NAME>="[url][#ref][=>holobranch]"
```

- Source names must be uppercased and all `-` (hyphen) characters changed to `_` (underscore).
- Existing values can be used by omitting values to the left, but ommitted values to the right will be cleared.
- The `--working` option currently has no effect on overridden sources: working tree changes for sources will be ignored. You'll need to commit any changes to use them in downstream builds, but you don't need to push those commits and you can rewrite/amend them continuously.

For example, give a source name of `skeleton-v1`:

```bash
export HOLO_SOURCE_SKELETON_V1="=>emergence-vfs-site" # use existing url+ref, override holobranch
export HOLO_SOURCE_SKELETON_V1="=>" # use existing url+ref, clear holobranch
export HOLO_SOURCE_SKELETON_V1="#refs/heads/develop" # use existing url, change ref, clear holobranch
export HOLO_SOURCE_SKELETON_V1="#refs/heads/develop=>emergence-skeleton" # use existing url, change ref, keep holobranch
export HOLO_SOURCE_SKELETON_V1="file:///src/skeleton-v1" # change url, clear ref+holobranch
export HOLO_SOURCE_SKELETON_V1="file:///src/skeleton-v1#refs/heads/develop=>emergence-skeleton" # change url+ref, keep holobranch
```

Environmental source overrides will be honored at every depth when using subprojections as sources, so while working on a project using `skeleton-v2` as a source, you could work on `skeleton-v2` and its source `skeleton-v1` simultaneously:

```bash
export HOLO_SOURCE_SKELETON_V2="file:///src/skeleton-v2#refs/heads/develop=>emergence-skeleton"
export HOLO_SOURCE_SKELETON_V1="file:///src/skeleton-v1#refs/heads/develop=>emergence-skeleton"
```

While working like this, you likely also want to environmentally instruct all hologit commands to always fetch the latest for these sources. This won't add an appreciable delay for local sources, but could slow down working against remote sources that aren't changing anyway:

```bash
export HOLO_FETCH="skeleton-v1:skeleton-v2"
```

## Method 2: Source Submodule Checkouts (Work in Progress)

Check out a named source as a submodule:

```bash
git holo source checkout skeleton-v1
```
