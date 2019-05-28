pkg_name=lens-sencha-pages
pkg_origin=holo
pkg_version="0.1.0"
pkg_maintainer="Chris Alfano <chris@jarv.us>"
pkg_license=("MIT")

pkg_deps=(
  core/git
  core/bash
  jarvus/sencha-cmd
  jarvus/hologit
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

INPUT_TREE="\${1?<input> required}"

# redirect all output to stderr
{
  # export git tree to disk
  git holo lens export-tree "\${INPUT_TREE}"

  # execute compilation
  pushd "\${GIT_WORK_TREE}" > /dev/null

  sencha \
    --sdk-path='./ext' \
    compile \
      --classpath='./ext/packages/core/src' \
      --classpath='./ext/packages/core/overrides' \
      --classpath='./pages/src' \
      union --recursive --tag='class' \
      and save core \
      and concat \
        --input-js-version='ANY' \
        --js-version='ANY' \
        --strip-comments \
        --output-file='./build/common.js' \
      and union --recursive --include-uses=no --tag='core' \
      and require --source-name='Ext.event.publisher.Dom' --requires='Ext.GlobalEvents' \
      and include --recursive --include-uses=no --class='Site.Common' \
      and exclude --set='core' \
      and concat \
        --input-js-version='ANY' \
        --js-version='ANY' \
        --strip-comments \
        --append \
        --output-file='./build/common.js'

  popd > /dev/null

  # add output to git index
  git add build
} 1>&2

# output tree hash
git write-tree --prefix=build

EOM
  chmod +x "bin/lens-tree"
  popd > /dev/null
}

do_strip() {
  return 0
}
