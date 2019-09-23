#!/bin/bash -e

cat /entrypoint.sh

# port hyphenated env to underscored, unless already set
INPUT_COMMIT_TO_HYPHENATED='INPUT_COMMIT-TO'
if [ -z "${INPUT_COMMIT_TO}" ] && [ -n "${!INPUT_COMMIT_TO_HYPHENATED}" ]; then
    export INPUT_COMMIT_TO="${!INPUT_COMMIT_TO_HYPHENATED}"
fi

# grab local copy of commit-to ref
if [ -n "${INPUT_COMMIT_TO}" ]; then
    git update-ref "refs/heads/${INPUT_COMMIT_TO}" "refs/remotes/origin/${INPUT_COMMIT_TO}"
fi

# run projection and return output
PROJECTION_OUTPUT=$(git holo project "$@")
echo ::set-output "name=last-projection::${PROJECTION_OUTPUT}"
