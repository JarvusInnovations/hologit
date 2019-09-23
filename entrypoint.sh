#!/bin/bash -e

git update-ref "refs/heads/${INPUT_COMMIT-TO}" "refs/remotes/origin/${INPUT_COMMIT-TO}"

PROJECTION_OUTPUT=$(git holo project "$@")

echo ::set-output "name=last-projection::${PROJECTION_OUTPUT}"
