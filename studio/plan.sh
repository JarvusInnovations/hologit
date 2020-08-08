pkg_name="hologit-studio"
pkg_origin="jarvus"
pkg_description="Studio subcomponent for hologit"
pkg_upstream_url="https://github.com/JarvusInnovations/hologit"
pkg_license=("MIT")
pkg_maintainer="Chris Alfano <chris@jarv.us>"

pkg_build_deps=(
  core/hab
)
pkg_deps=(
  core/coreutils
  jarvus/hologit
)

pkg_exports=(
  [debug.port]=debug.port
)
pkg_exposes=(debug.port)
pkg_svc_user="root"
pkg_svc_run="git-holo studio --socket ${pkg_svc_var_path}/studio.sock"


pkg_version() {
  hab pkg path jarvus/hologit | cut -d/ -f6
}

# implement build workflow
do_before() {
  do_default_before
  update_pkg_version
}

do_build() {
  return 0
}

do_install() {
  return 0
}
