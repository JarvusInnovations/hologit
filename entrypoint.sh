#!/bin/bash -e

echo "Projections: ${1}"

echo ::set-output "name=last-projection::abcdef1234567890"

echo "Filesystem:"
hab pkg exec core/tree tree -x -L 5 -F /

echo "Env:"
hab pkg exec core/coreutils printenv
