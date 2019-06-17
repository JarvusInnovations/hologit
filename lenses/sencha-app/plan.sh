pkg_name=lens-sencha-app
pkg_origin=holo
pkg_version="0.1.0"
pkg_maintainer="Chris Alfano <chris@jarv.us>"
pkg_license=("MIT")

pkg_deps=(
  core/git
  core/bash
  jarvus/sencha-cmd
  jarvus/hologit
  jarvus/underscore
)

pkg_bin_dirs=(bin)


do_build() {
  return 0
}

do_install() {
  build_line "Generating lens script"

  pushd "${pkg_prefix}" > /dev/null
  cp "${PLAN_CONTEXT}/"{build-app,lens-tree} "bin/"
  fix_interpreter "bin/*" core/bash bin/bash
  chmod +x "bin/"*
  popd > /dev/null
}

do_strip() {
  return 0
}
