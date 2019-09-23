#!/bin/bash -e

# port hyphenated env to underscored, unless already set
INPUT_COMMIT_TO_HYPHENATED='INPUT_COMMIT-TO'
if [ -z "${INPUT_COMMIT_TO}" ]; then
    while IFS= read -r -d '' var; do
        [[ $var = "$INPUT_COMMIT_TO_HYPHENATED"=* ]] || continue
        export INPUT_COMMIT_TO=${var#"${INPUT_COMMIT_TO_HYPHENATED}="}
        break
    done </proc/self/environ
fi

# grab local copy of commit-to ref
if [ -n "${INPUT_COMMIT_TO}" ]; then
    COMMIT_TO_HASH=$(git rev-parse --verify "refs/remotes/origin/${INPUT_COMMIT_TO}" 2>&- || true)
    if [ -n "${COMMIT_TO_HASH}" ]; then
        git update-ref "refs/heads/${INPUT_COMMIT_TO}" "${COMMIT_TO_HASH}"
    fi
fi

# run projection and return output
PROJECTION_OUTPUT=$(git holo project "$@")
echo ::set-output "name=last-projection::${PROJECTION_OUTPUT}"
