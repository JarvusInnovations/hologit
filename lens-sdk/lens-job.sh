#!/bin/sh
# lens-job.sh — reference SDK entrypoint for the hologit v2 lens job protocol
#
# Implements the one-shot mode of the job protocol defined in
# specs/behaviors/lensing.md (hologit repo). A v2 lens image carries the OCI
# label `sh.holo.lens.protocol=2` and an entrypoint implementing this contract:
#
#   stdin:  a git bundle containing `refs/jobs/<spec-hash>/input` — a commit
#           whose tree is a wrapper: `.holospec/lens.toml` (the full lens spec)
#           alongside `input/` (the input tree).
#   stdout: a git bundle containing exactly one of:
#             `refs/jobs/<spec-hash>/output` — success: a commit whose FIRST
#                 PARENT is the input commit and whose tree is the bare result;
#             `refs/jobs/<spec-hash>/error`  — failure: a commit whose tree
#                 contains at minimum `exit-code` and `log` entries.
#   exit:   0 on success; the lens command's exit code on failure. stdout is
#           reserved for the bundle — ALL logging goes to stderr.
#
# Everything between reading the input and emitting the bundle is SDK-internal;
# this reference SDK runs the spec's `command` with:
#
#   cwd                the materialized wrapper tree (so `.holospec/` and
#                      `input/` are both visible)
#   HOLOLENS_INPUT     absolute path of the materialized `input/` directory
#   HOLOLENS_OUTPUT    absolute path of an empty directory the command must
#                      populate with its result
#   HOLOLENS_SPEC      absolute path of `.holospec/lens.toml`
#
# `{{ input }}` and `{{ output }}` placeholders in `command` are substituted
# with those paths. The command's stdout+stderr are captured as the job log
# and relayed to stderr.
#
# Requires only git and a POSIX shell (busybox-compatible).

set -eu

log() { echo "lens-job: $*" >&2; }

JOB_DIR=$(mktemp -d)
LOG_FILE="$JOB_DIR/log"
: > "$LOG_FILE"

export GIT_DIR="$JOB_DIR/repo.git"
git init --quiet --bare "$GIT_DIR"
git config user.name 'hologit lens'
git config user.email 'lens-job@hologit'

# --- 1. ingest the input bundle from stdin (fetch verifies all objects) ------
BUNDLE_IN="$JOB_DIR/input.bundle"
cat > "$BUNDLE_IN"
git fetch --quiet "$BUNDLE_IN" 'refs/jobs/*:refs/jobs/*' >&2

# --- 2. locate the job ---------------------------------------------------------
INPUT_REF=$(git for-each-ref --format='%(refname)' 'refs/jobs/*/input' | head -n 1)
if [ -z "$INPUT_REF" ]; then
    log 'transport error: no refs/jobs/*/input ref found in bundle'
    exit 65
fi
SPEC_HASH=${INPUT_REF#refs/jobs/}
SPEC_HASH=${SPEC_HASH%/input}
INPUT_COMMIT=$(git rev-parse "$INPUT_REF")
log "job ${SPEC_HASH}: input commit ${INPUT_COMMIT}"

emit_error() {
    code=$1
    printf '%s' "$code" > "$JOB_DIR/exit-code"
    EXIT_BLOB=$(git hash-object -w "$JOB_DIR/exit-code")
    LOG_BLOB=$(git hash-object -w "$LOG_FILE")
    ERROR_TREE=$(printf '100644 blob %s\texit-code\n100644 blob %s\tlog\n' "$EXIT_BLOB" "$LOG_BLOB" | git mktree)
    ERROR_COMMIT=$(git commit-tree "$ERROR_TREE" -m "lens job ${SPEC_HASH} failed with exit code ${code}")
    git update-ref "refs/jobs/${SPEC_HASH}/error" "$ERROR_COMMIT"
    git bundle create "$JOB_DIR/error.bundle" "refs/jobs/${SPEC_HASH}/error" >&2
    cat "$JOB_DIR/error.bundle"
    log "job ${SPEC_HASH}: emitted error bundle (exit code ${code})"
    exit "$code"
}

# --- 3. materialize the wrapper tree ------------------------------------------
WORK_DIR="$JOB_DIR/work"
mkdir -p "$WORK_DIR"
git archive "$INPUT_COMMIT" | tar -x -C "$WORK_DIR"

SPEC_FILE="$WORK_DIR/.holospec/lens.toml"
if [ ! -f "$SPEC_FILE" ]; then
    log 'transport error: input commit has no .holospec/lens.toml'
    exit 65
fi

INPUT_DIR="$WORK_DIR/input"
OUTPUT_DIR="$JOB_DIR/output"
mkdir -p "$INPUT_DIR" "$OUTPUT_DIR"

# --- 4. read `command` from the spec (basic TOML string extraction) ------------
COMMAND=$(sed -n 's/^command[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$SPEC_FILE" | head -n 1)
if [ -z "$COMMAND" ]; then
    log "spec ${SPEC_HASH} has no command"
    echo "spec has no command" >> "$LOG_FILE"
    emit_error 64
fi
# unescape TOML basic-string escapes for quotes and backslashes
COMMAND=$(printf '%s' "$COMMAND" | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')
# substitute {{ input }} / {{ output }} placeholders
COMMAND=$(printf '%s' "$COMMAND" | sed -e "s|{{ *input *}}|${INPUT_DIR}|g" -e "s|{{ *output *}}|${OUTPUT_DIR}|g")

# --- 5. run the lens command ----------------------------------------------------
log "executing lens command: $COMMAND"
set +e
(
    cd "$WORK_DIR" \
    && HOLOLENS_INPUT="$INPUT_DIR" \
       HOLOLENS_OUTPUT="$OUTPUT_DIR" \
       HOLOLENS_SPEC="$SPEC_FILE" \
       sh -c "$COMMAND"
) >> "$LOG_FILE" 2>&1
CODE=$?
set -e

# relay the job log to stderr (never stdout — that's the bundle channel)
sed 's/^/lens: /' "$LOG_FILE" >&2

if [ "$CODE" -ne 0 ]; then
    log "lens command failed with exit code ${CODE}"
    emit_error "$CODE"
fi

# --- 6. commit the output tree as first-parent child of the input commit -------
export GIT_INDEX_FILE="$JOB_DIR/index"
git --work-tree="$OUTPUT_DIR" add -A .
OUTPUT_TREE=$(git write-tree)
OUTPUT_COMMIT=$(git commit-tree "$OUTPUT_TREE" -p "$INPUT_COMMIT" -m "lens job ${SPEC_HASH}")
git update-ref "refs/jobs/${SPEC_HASH}/output" "$OUTPUT_COMMIT"
log "job ${SPEC_HASH}: output tree ${OUTPUT_TREE}"

# --- 7. emit the output bundle on stdout ----------------------------------------
# exclude objects reachable from the input commit — the engine already has them
git bundle create "$JOB_DIR/output.bundle" "refs/jobs/${SPEC_HASH}/output" "^${INPUT_COMMIT}" >&2
cat "$JOB_DIR/output.bundle"
log "job ${SPEC_HASH}: emitted output bundle"
exit 0
