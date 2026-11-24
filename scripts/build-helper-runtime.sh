#!/usr/bin/env bash
# Builds the helper runtime image (helper-runtime/Dockerfile) once, saves it as helper-runtime.tar, proves the tar and
# prints its two pins. Used by the CI job (build and verify) and by the release workflow (build, then pin before the
# DockNest image is built). Needs Docker with buildx on a linux/amd64 host. It uses no secrets and no network after the
# build, and it never pushes anything.
#   scripts/build-helper-runtime.sh [--pin]    --pin writes the IDs into shared/helper-runtime.js (release build only)
set -euo pipefail
cd "$(dirname "$0")/.."
tag=docknest-helper-runtime:release
rm -f helper-runtime.tar
# provenance and SBOM attestations would turn the output into an index with more than one image; the ID must name one image.
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --no-cache --output "type=docker,dest=helper-runtime.tar,name=$tag" helper-runtime
chmod 0644 helper-runtime.tar
id=$(node scripts/pin-helper-runtime.js --id-from-tar helper-runtime.tar)
layers=$(node scripts/pin-helper-runtime.js --layers-from-tar helper-runtime.tar)
manifest=$(node scripts/pin-helper-runtime.js --manifest-digest-from-tar helper-runtime.tar)
sha=$(sha256sum helper-runtime.tar | cut -d' ' -f1)
size=$(stat -c %s helper-runtime.tar)
[ "$size" -gt 0 ] && [ "$size" -le $((512 * 1024 * 1024)) ] || { echo "::error::unexpected tar size $size"; exit 1; }

# Prove the tar the way a NAS will use it: load it fresh and compare the image's layers (content hashes, equal on every Docker
# image store) with the ones named in the tar. The image ID itself differs between the classic and the containerd store, so the
# checks below run the image by the ID this Docker reports, as DockNest does on a NAS.
docker image rm -f "$tag" > /dev/null 2>&1 || true
docker load -i helper-runtime.tar > /dev/null
[ "$(docker image inspect --format '{{json .RootFS.Layers}}' "$tag")" = "$layers" ] || { echo "::error::the loaded layers differ from the tar's"; exit 1; }
run_id=$(docker image inspect --format '{{.Id}}' "$tag")
# The ID this Docker reports is the config digest (classic store) or the manifest digest (containerd store): one of the two pins.
[ "$run_id" = "$id" ] || [ "$run_id" = "$manifest" ] || { echo "::error::the loaded image ID $run_id is neither the config digest $id nor the manifest digest $manifest"; exit 1; }
[ "$(docker image inspect --format '{{index .Config.Labels "org.docknest.helper"}}' "$run_id")" = 1 ] || { echo "::error::the DockNest label is missing"; exit 1; }
[ "$(docker image inspect --format '{{.Architecture}}/{{.Os}}' "$run_id")" = amd64/linux ] || { echo "::error::not a linux/amd64 image"; exit 1; }
# The helper's needs: Python 3.9+, the Docker CLI and tar, with no network.
docker run --rm --network none "$run_id" python3 -c 'import sys; assert sys.version_info >= (3, 9), sys.version'
docker run --rm --network none "$run_id" docker --version > /dev/null
docker run --rm --network none "$run_id" tar --version > /dev/null
# No network really means none: only the loopback interface exists.
[ "$(docker run --rm --network none "$run_id" python3 -c 'import socket; print(len(socket.if_nameindex()))')" = 1 ] || { echo "::error::the container has a network interface"; exit 1; }

echo "helper runtime image: $id (this Docker runs it as $run_id)"
echo "helper runtime layers: $layers"
echo "helper runtime manifest digest: $manifest"
echo "helper runtime tar sha256: $sha ($size bytes)"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || { echo "Helper runtime image \`$id\` (tar sha256 \`$sha\`, $size bytes)" >> "$GITHUB_STEP_SUMMARY"; }
if [ "${1:-}" = --pin ]; then node scripts/pin-helper-runtime.js --image-id "$id" --tar-sha256 "$sha" --layers "$layers" --manifest-digest "$manifest"; fi
