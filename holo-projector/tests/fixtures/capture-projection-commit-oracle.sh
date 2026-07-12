#!/bin/bash
# Capture the JS engine's projection-commit bytes on a deterministic fixture
# repo — the oracle side of holo-projector/tests/commit.rs (see
# specs/behaviors/projection-commits.md § Conformance fixtures).
#
# Usage:  holo-projector/tests/fixtures/capture-projection-commit-oracle.sh
#
# The fixture path is fixed because the working-tree-mode commit embeds the
# absolute path in its message (oracle quirk, specced): changing the path
# changes ORACLE_WORKING's hash. Every value printed under "summary"
# corresponds to a constant in tests/commit.rs.
set -euo pipefail

CLONE=$(cd "$(dirname "$0")/../../.." && pwd)
FIXTURE=/tmp/holo-oracle-fixture

export GIT_AUTHOR_NAME='Holo Author'
export GIT_AUTHOR_EMAIL='author@example.com'
export GIT_AUTHOR_DATE='1700000000 +0000'
export GIT_COMMITTER_NAME='Holo Committer'
export GIT_COMMITTER_EMAIL='committer@example.com'
export GIT_COMMITTER_DATE='1700000001 +0000'
export HOLO_ENGINE=js
export HOLO_CACHE_FROM=

rm -rf "$FIXTURE"
git init -q -b main "$FIXTURE"
cd "$FIXTURE"
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git config commit.gpgsign false

mkdir -p docs .holo/branches/proj
printf 'hello\n' > README.md
printf 'docs content\n' > docs/index.md
printf '[holospace]\nname = "fixture"\n' > .holo/config.toml
printf '[holomapping]\nfiles = "**"\n' > .holo/branches/proj/_fixture.toml
git add -A
git commit -q -m 'initial commit'

echo "SOURCE_COMMIT=$(git rev-parse HEAD)"
echo "DESCRIBE=$(git describe --always --tags HEAD)"

project() {
    node "$CLONE/bin/cli.js" project proj --no-lens "$@" 2>/dev/null
}

# Case A: ref absent -> init commit + projection commit
project --commit-to=refs/holo/projected > /dev/null
echo "ORACLE_INIT=$(git rev-parse 'refs/holo/projected^')"
echo "ORACLE_FIRST=$(git rev-parse refs/holo/projected)"
echo "PROJECTED_TREE=$(git rev-parse 'refs/holo/projected^{tree}')"

# Case B: ref exists -> previous projection commit as first parent
project --commit-to=refs/holo/projected > /dev/null
echo "ORACLE_SECOND=$(git rev-parse refs/holo/projected)"

# Case C: custom message (trailers dropped)
project --commit-to=refs/holo/projected-msg --commit-message='custom message here' > /dev/null
echo "ORACLE_CUSTOM=$(git rev-parse refs/holo/projected-msg)"

# Case D: no source parent (single parent, no Source-commit trailer)
project --commit-to=refs/holo/projected-nosrc --no-commit-source-parent > /dev/null
echo "ORACLE_NO_SOURCE=$(git rev-parse refs/holo/projected-nosrc)"

# Case E: working-tree mode (path in message, only Source-holobranch trailer)
project --working --commit-to=refs/holo/projected-working > /dev/null
echo "ORACLE_WORKING=$(git rev-parse refs/holo/projected-working)"

# Case F: bare ref name -> refs/heads/ prefix (same bytes as case A)
project --commit-to=projected-bare > /dev/null
echo "ORACLE_BARE=$(git rev-parse refs/heads/projected-bare)"

echo
echo "--- raw commit bytes (case B) ---"
git cat-file commit refs/holo/projected
