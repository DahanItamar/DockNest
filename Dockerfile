# The base image is pinned by digest (the multi-arch index of node:24-bookworm-slim); bump tag and digest together.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data NODE_OPTIONS=--no-addons
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/remote ./remote
# Release notes ship with the image so the dashboard can show what changed without going online.
COPY --from=build --chown=node:node /app/docs/releases ./docs/releases
COPY --from=build --chown=node:node /app/CHANGELOG.md ./CHANGELOG.md
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
