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

# resolve full ref name for commit-to
if [ -n "${INPUT_COMMIT_TO}" ]; then
    INPUT_COMMIT_TO_REF=$(git rev-parse --symbolic-full-name "${INPUT_COMMIT_TO}")
fi

# grab local copy of commit-to ref
if [ -n "${INPUT_COMMIT_TO_REF}" ]; then
    COMMIT_TO_HASH=$(git rev-parse --verify "refs/remotes/origin/${INPUT_COMMIT_TO}" 2>&- || true)
    if [ -n "${COMMIT_TO_HASH}" ]; then
        git update-ref "${INPUT_COMMIT_TO_REF}" "${COMMIT_TO_HASH}"
    fi
fi

# configure author of HEAD as author of any commits in this session
git config --global user.name "$(git --no-pager log -1 --pretty=format:'%an')"
git config --global user.email "$(git --no-pager log -1 --pretty=format:'%ae')"

# run projection and return output
PROJECTION_OUTPUT=$(git holo project "$@")
echo ::set-output "name=last-projection::${PROJECTION_OUTPUT}"

# push output
if [ -n "${INPUT_COMMIT_TO_REF}" ]; then
    git push origin "${INPUT_COMMIT_TO_REF}"
fi
