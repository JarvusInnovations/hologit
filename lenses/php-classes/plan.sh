pkg_name=hololens-php-classes
pkg_origin=emergence
pkg_version="0.1.0"
pkg_maintainer="Chris Alfano <chris@jarv.us>"
pkg_license=("MIT")

pkg_deps=(
  core/bash
)

pkg_bin_dirs=(bin)


do_build() {
  return 0
}

do_install() {
  build_line "Generating lens script"

  pushd "${pkg_prefix}" > /dev/null
  cat > "bin/lens-tree" <<- EOM
#!$(pkg_path_for bash)/bin/sh

echo "\${1}"
EOM
  chmod +x "bin/lens-tree"
  popd > /dev/null
}

do_strip() {
  return 0
}