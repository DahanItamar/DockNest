# The base image is pinned by digest (the multi-arch index of node:24-bookworm-slim); bump tag and digest together.
# rclone is the transport for cloud-drive destinations (docs/cloud-drives.md). One pinned linux/amd64 release, checked against
# the SHA-256 below (taken from the release's signed SHA256SUMS; verify the PGP signature of that file when the pin is
# bumped). Keep RCLONE_VERSION in step with src/storage/rclone-pin.js (a test compares them). Other CPU architectures get
# no binary: cloud-drive destinations then report that rclone is missing, everything else works as before.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS rclone
LABEL io.github.dahanitamar.docknest=build
ARG RCLONE_VERSION=v1.70.3
ARG RCLONE_SHA256=7d69057e69385f6514a9684c7eaa424d972096b130284bb34dd967c4ed4f9dad
RUN mkdir /out && if [ "$(dpkg --print-architecture)" = amd64 ]; then  apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*  && curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-amd64.zip"  && echo "${RCLONE_SHA256}  /tmp/rclone.zip" | sha256sum -c -  && unzip -j /tmp/rclone.zip "rclone-${RCLONE_VERSION}-linux-amd64/rclone" -d /out && chmod 0755 /out/rclone; fi
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
# Every image this file produces carries this label, so scripts/upgrade.sh can prove an untagged image is DockNest's own
# (an older release or a build stage) before it removes it; it never removes an untagged image without it.
LABEL io.github.dahanitamar.docknest=build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
LABEL io.github.dahanitamar.docknest=app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data NODE_OPTIONS=--no-addons
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown node:node /data
COPY --from=rclone /out/ /usr/local/bin/
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/remote ./remote
COPY --from=build --chown=node:node /app/assets/fonts ./assets/fonts
# Release notes ship with the image so the dashboard can show what changed without going online.
COPY --from=build --chown=node:node /app/docs/releases ./docs/releases
COPY --from=build --chown=node:node /app/CHANGELOG.md ./CHANGELOG.md
# The helper runtime image (docs/nas-servers.md) when the release build made one. CHANGELOG.md is named only so the
# pattern can match nothing in a plain build (the glob keeps COPY from failing); without the tar the container runtime refuses.
COPY CHANGELOG.md helper-runtime.ta[r] /app/
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
