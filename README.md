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

## Map parent source content into holobranch

```bash
cat <<EOT > .holo/branches/static-website/_html5-boilerplate.toml
[holomapping]
# holosource = "html5-boilerplate" # implied by filename
before = "*" # apply before any other layer
root = "dist"
files = [
    "**",
    "!**/.*", # exclude all dotfiles
    "!browserconfig.xml",
    "!doc/"
]
EOT
```

## Examine projection with parent source content

```console
$ git ls-tree -r $(git holo project static-website)

info: reading mappings from holobranch: static-website
info: compositing tree...
info: merging html5-boilerplate:dist/{**,!**/.*,!browserconfig.xml,!doc/} -> /
info: merging hologit-example:{**} -> /
info: stripping .holo/{branches,sources} tree from output tree...
info: stripping .holo/lenses tree from output tree...
info: stripping empty .holo/ tree from output tree...
info: writing final output tree...
info: projection ready
100644 blob 260cc4c97bebbde06467efe39be5b6008ec19265    404.html
100644 blob 294e91d808263f2f5f935aed22e3cbce9faf8771    LICENSE.txt
100644 blob 7bcb0266b9d40f15c04626585e2e3a1feaba77ed    README.md
100644 blob c1316d4e50ff79d2ff93033c55a99d030a26a779    css/main.css
100644 blob 192eb9ce43389039996bc2e9344c5bb14b730d72    css/normalize.css
100644 blob be74abd69ad6a32de7375df13cab9354798e328f    favicon.ico
100644 blob 8d2330fdb28aa243b5c4b09f4a2a2e9b00a79dd3    humans.txt
100644 blob 8a42581d4a2a2a28bee1888835d21ffe4d6378d0    icon.png
100644 blob 8d4461ea4a69aaf4fc703a0f47010c05ba1dfcb0    index.html
100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391    js/main.js
100644 blob feb7d19e6e5ff6b45f3d87bbae09794b9006f3ed    js/plugins.js
100644 blob 47b639702ccbb7cc5ce9c38556560b617e604fcd    js/vendor/jquery-3.5.0.min.js
100644 blob 14fb326449739e7811ef48f88f7ec8272c869aa8    js/vendor/modernizr-3.10.0.min.js
100644 blob 1f53798bb4fe33c86020be7f10c44f29486fd190    robots.txt
100644 blob 222ae169e976b699e8158dab96f5f036bf7b0eb4    site.webmanifest
100644 blob ccd739c7da5f47f6f36c9de6163cab77b534da6a    tile-wide.png
100644 blob f820f61a0b95dd42dca6cbd06ca08ed4e1ef098a    tile.png
```
