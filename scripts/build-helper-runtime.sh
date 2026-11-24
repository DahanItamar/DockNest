#!/usr/bin/env bash
# Builds the helper runtime image (helper-runtime/Dockerfile) once, saves it as helper-runtime.tar, proves the tar and
# prints its two pins. Used by the CI job (build and verify) and by the release workflow (build, then pin before the
# DockNest image is built). Needs Docker with buildx on a linux/amd64 host. It uses no secrets and no network after the
# build, and it never pushes anything.
#   scripts/build-helper-runtime.sh [--pin]    --pin writes the IDs into shared/helper-runtime.js (release build only)
set -euo pipefail
cd "$(dirname "$0")/.."
tag=docknest-helper-runtime:build
rm -f helper-runtime.tar
# provenance and SBOM attestations would turn the output into an index with more than one image; the ID must name one image.
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --no-cache --output "type=docker,dest=helper-runtime.tar,name=$tag" helper-runtime
chmod 0644 helper-runtime.tar
id=$(node scripts/pin-helper-runtime.js --id-from-tar helper-runtime.tar)
sha=$(sha256sum helper-runtime.tar | cut -d' ' -f1)
size=$(stat -c %s helper-runtime.tar)
[ "$size" -gt 0 ] && [ "$size" -le $((512 * 1024 * 1024)) ] || { echo "::error::unexpected tar size $size"; exit 1; }

# Prove the tar the way a NAS will use it: load it fresh and compare the ID Docker reports with the one named in the tar.
docker image rm -f "$tag" > /dev/null 2>&1 || true
docker load -i helper-runtime.tar > /dev/null
loaded=$(docker image inspect --format '{{.Id}}' "$id")
[ "$loaded" = "$id" ] || { echo "::error::loaded image ID $loaded differs from the tar's $id"; exit 1; }
[ "$(docker image inspect --format '{{index .Config.Labels "org.docknest.helper"}}' "$id")" = 1 ] || { echo "::error::the DockNest label is missing"; exit 1; }
[ "$(docker image inspect --format '{{.Architecture}}/{{.Os}}' "$id")" = amd64/linux ] || { echo "::error::not a linux/amd64 image"; exit 1; }
# The helper's needs: Python 3.9+, the Docker CLI and tar, with no network.
docker run --rm --network none "$id" python3 -c 'import sys; assert sys.version_info >= (3, 9), sys.version'
docker run --rm --network none "$id" docker --version > /dev/null
docker run --rm --network none "$id" tar --version > /dev/null
# No network really means none: only the loopback interface exists.
[ "$(docker run --rm --network none "$id" python3 -c 'import socket; print(len(socket.if_nameindex()))')" = 1 ] || { echo "::error::the container has a network interface"; exit 1; }

echo "helper runtime image: $id"
echo "helper runtime tar sha256: $sha ($size bytes)"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || { echo "Helper runtime image \`$id\` (tar sha256 \`$sha\`, $size bytes)" >> "$GITHUB_STEP_SUMMARY"; }
if [ "${1:-}" = --pin ]; then node scripts/pin-helper-runtime.js --image-id "$id" --tar-sha256 "$sha"; fi
