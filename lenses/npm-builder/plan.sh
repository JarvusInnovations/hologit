pkg_name=lens-npm-build
pkg_origin=holo
pkg_version="0.1.0"
pkg_maintainer="Chris Alfano <chris@jarv.us>"
pkg_license=("MIT")

hololens_deps=(
    npm-development
)
hololens_input_files=(
    "**/package.json"
)
hololens_output_merge="graft"
