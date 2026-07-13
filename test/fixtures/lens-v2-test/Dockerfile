# Throwaway v2 lens image for integration tests (test/integration/lens-v2.test.js).
#
# Built locally by the test suite and NEVER pushed — which is exactly the point:
# it exercises the local-only branch of the container identity-resolution ladder
# (specs/behaviors/lensing.md, #417).
#
# Build from the repo root so the reference SDK can be copied in:
#
#   docker build -t holo-lens-v2-test \
#       --label sh.holo.lens.protocol=2 \
#       -f test/fixtures/lens-v2-test/Dockerfile .
#
# The protocol label is applied at build time (--label) rather than here so the
# same Dockerfile can also build an unlabeled image for v1-fallback detection
# tests.

FROM alpine:3

RUN apk add --no-cache git

COPY lens-sdk/lens-job.sh /usr/local/bin/lens-job.sh
COPY test/fixtures/lens-v2-test/holo-lens-test /usr/local/bin/holo-lens-test
COPY test/fixtures/lens-v2-test/holo-lens-fail /usr/local/bin/holo-lens-fail
RUN chmod +x /usr/local/bin/lens-job.sh /usr/local/bin/holo-lens-test /usr/local/bin/holo-lens-fail

ENTRYPOINT ["/usr/local/bin/lens-job.sh"]
