# The DockNest helper runtime (docs/nas-servers.md): runs the helper on a NAS that has no usable Python. linux/amd64 only.
# It is built once per release by scripts/build-helper-runtime.sh, saved to helper-runtime.tar, shipped inside the DockNest
# image and loaded on the NAS over SSH. DockNest runs it by its image ID (a SHA-256 pinned in shared/helper-runtime.js),
# never by tag, never pulled. No ENTRYPOINT, no network access is configured here, no ports, no volumes.
# The base is pinned by digest (the multi-arch index of alpine:3.20, looked up from the registry; bump tag and digest
# together). Packages come from Alpine's signed repositories at build time; the image ID recorded by the release build is
# what ties a release to exactly these bytes.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
# Marks the image as DockNest's own: an old runtime is removed from a NAS only when it carries this label.
LABEL org.docknest.helper=1
# Python 3 (standard library only is used), the Docker CLI (talks to the host's socket) and tar for archives.
# Exact versions (Alpine 3.20 repositories). Alpine removes superseded versions, so a build that fails here on a missing version
# is the signal to bump this line and the base digest together; their own dependencies are fixed by the base image and the
# release build's recorded layers.
RUN apk add --no-cache python3=3.12.13-r0 docker-cli=26.1.5-r0 tar=1.35-r2 && rm -rf /var/cache/apk/*
# Runs as root on purpose: the helper must read and write host folders as root and use the Docker socket, which is
# root-equivalent already. The container has no network by default, no published ports and exits after each call.
WORKDIR /
