#!/bin/bash -e

git fetch origin "refs/heads/${INPUT_COMMIT-TO}"

PROJECTION_OUTPUT=$(git holo project "$@")

echo ::set-output "name=last-projection::${PROJECTION_OUTPUT}"
