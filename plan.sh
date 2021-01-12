pkg_name="hologit"
pkg_origin="jarvus"
pkg_description="A universal, git-native tool for assembling software"
pkg_upstream_url="https://github.com/JarvusInnovations/hologit"
pkg_license=("MIT")
pkg_maintainer="Chris Alfano <chris@jarv.us>"
pkg_build_deps=(
  jarvus/underscore
)

pkg_deps=(
  core/git
  jarvus/node12 # newer than core/node12
  core/hab/0.79.0 # last version before new license
)

pkg_bin_dirs=(bin)


pkg_version() {
  underscore extract version --outfmt text --in "${PLAN_CONTEXT}/package.json"
}

# implement build workflow
do_before() {
  do_default_before
  update_pkg_version
}

do_build() {
  pushd "${CACHE_PATH}" > /dev/null

  build_line "Copying application to ${CACHE_PATH}"
  cp "${PLAN_CONTEXT}/LICENSE" "${PLAN_CONTEXT}/package.json" ./
  cp -r "${PLAN_CONTEXT}/commands" "${PLAN_CONTEXT}/lib" ./
  cp -r "${PLAN_CONTEXT}/bin" ./node-bin

  build_line "Installing dependencies with NPM"
  npm install

  build_line "Fixing interpreter"
  sed -e "s#\#\!/usr/bin/env node#\#\!$(pkg_path_for node12)/bin/node#" --in-place "node-bin/cli.js"

  popd > /dev/null
}

do_install() {
  pushd "${CACHE_PATH}" > /dev/null

  cp -r ./* "${pkg_prefix}/"

  # TODO: remove this once habitat#4493 is resolved
  build_line "Creating git-holo command"
  cat > "${pkg_prefix}/bin/git-holo" <<- EOM
#!/bin/sh
export PATH="\${PATH}:$(_assemble_runtime_path)"
exec ${pkg_prefix}/node-bin/cli.js \$@
EOM
  chmod +x "${pkg_prefix}/bin/git-holo"

  popd > /dev/null
}

do_strip() {
  return 0
}

