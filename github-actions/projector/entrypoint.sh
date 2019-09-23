#!/bin/bash -e

echo "Holobranch: ${1}"
echo "All args: $*"

echo ::set-output "name=last-projection::abcdef1234567890"

echo
echo
echo "Filesystem:"
hab pkg exec core/tree tree -x -L 5 -F /

echo
echo
echo "Env:"
hab pkg exec core/coreutils printenv
