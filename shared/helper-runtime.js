// The helper runtime container (docs/nas-servers.md): what DockNest runs on a NAS that has no usable Python.
// The image is shipped inside the DockNest image, loaded over SSH and referenced by its image ID (a SHA-256 digest),
// never by a tag and never pulled. The release build (scripts/build-helper-runtime.sh, then scripts/pin-helper-runtime.js)
// sets HELPER_RUNTIME_IMAGE_ID and HELPER_RUNTIME_TAR_SHA256 in the copy of this file that goes into the DockNest image.
// In the repository both stay null, so a source build refuses the container runtime (fail closed) and only the host
// runtime is available. Do not edit these two lines by hand: the pin script is the only writer and validates both.
export const HELPER_RUNTIME_NAME = 'docknest-helper-runtime';
export const HELPER_RUNTIME_LABEL = 'org.docknest.helper=1';
export const HELPER_RUNTIME_TAR = '/app/helper-runtime.tar';
export const HELPER_RUNTIME_IMAGE_ID = null; // 'sha256:' + 64 lowercase hex, set by the release build
export const HELPER_RUNTIME_TAR_SHA256 = null; // 64 lowercase hex: SHA-256 of /app/helper-runtime.tar, set by the release build
export const MIN_HOST_PYTHON = [3, 9];
export const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
// Helper operations that may use the host network (restore test probes, domain checks). Everything else gets none.
export const HOST_NETWORK_OPERATIONS = Object.freeze(['domain-routes', 'restore-test-run']);
export const TAR_SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const isTarSha256 = value => typeof value === 'string' && TAR_SHA256_PATTERN.test(value);
export const isPinnedImageId = value => typeof value === 'string' && IMAGE_ID_PATTERN.test(value);
