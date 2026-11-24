// The helper runtime container (docs/nas-servers.md): what DockNest runs on a NAS that has no usable Python.
// The image is shipped inside the DockNest image, loaded over SSH and referenced by its image ID (a SHA-256 digest),
// never by a tag and never pulled. The release workflow that builds the image sets HELPER_RUNTIME_IMAGE_ID; until
// it is set, the container runtime refuses to run (fail closed) and only the host runtime is available.
export const HELPER_RUNTIME_NAME = 'docknest-helper-runtime';
export const HELPER_RUNTIME_LABEL = 'org.docknest.helper=1';
export const HELPER_RUNTIME_TAR = '/app/helper-runtime.tar';
export const HELPER_RUNTIME_IMAGE_ID = null; // 'sha256:' + 64 lowercase hex, set by the release build
export const MIN_HOST_PYTHON = [3, 9];
export const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
// Helper operations that may use the host network (restore test probes, domain checks). Everything else gets none.
export const HOST_NETWORK_OPERATIONS = Object.freeze(['domain-routes', 'restore-test-run']);
export const isPinnedImageId = value => typeof value === 'string' && IMAGE_ID_PATTERN.test(value);
