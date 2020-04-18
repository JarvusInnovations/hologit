# Hologit Examples: html5-boilerplate

## Initialize holorepo

```bash
git holo init
```

## Add some sample content

```bash
cat <<EOT > robots.txt
User-agent: *
Disallow: /
EOT
```

## Initialize `static-website` holobranch

```bash
git holo branch create --template=passthrough static-website
```

## Examine initial projection

```console
$ git ls-tree -r $(git holo project static-website)

info: reading mappings from holobranch: static-website
info: compositing tree...
info: merging hologit-example:{**} -> /
info: stripping .holo/{branches,sources} tree from output tree...
info: stripping .holo/lenses tree from output tree...
info: stripping empty .holo/ tree from output tree...
info: writing final output tree...
info: projection ready
100644 blob 78b8641798e8ac38ca7dd079757abe2ce3faf850    README.md
100644 blob 1f53798bb4fe33c86020be7f10c44f29486fd190    robots.txt
```

## Add parent source

```bash
git holo source create https://github.com/h5bp/html5-boilerplate
```
