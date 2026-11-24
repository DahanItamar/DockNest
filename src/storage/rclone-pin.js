// The rclone release DockNest ships (Dockerfile ARG RCLONE_VERSION; a test keeps both in step). Source installs need
// rclone on PATH at this major.minor or newer.
export const RCLONE_VERSION='1.70.3';
export const RCLONE_MINIMUM={major:1,minor:70};
