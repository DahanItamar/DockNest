# NAS servers: helper runtime and sudo mode (backend)

Backend building blocks for Unraid, Synology DSM and TrueNAS SCALE. Nothing here changes a server that is not detected
as a NAS: those keep the exact command and root identity DockNest has always used. The screens, discovery of NAS app
managers and the connect wizard come in later changes.

## What exists

- **Detection** (`src/nas/detect.js`): read-only facts read with fixed argv (no shell, no Python needed): `/etc/unraid-version`;
  `/etc/synoinfo.conf` with `/etc.defaults/VERSION`; `/etc/version` containing TrueNAS with `midclt`. TrueNAS before 24.10 is refused.
- **Identity**: root key, or a non-root user with passwordless sudo, only on a detected NAS. The helper runs as
  `sudo -n -- python3 -c <loader>`: one fixed argv, every element quoted, never a shell string. No `sudo -S`, `-i`, `-s`, `-E`,
  no password storage, no sudoers changes. If `sudo -n` needs a password, the readiness check fails with one fix and no
  other command runs as root. Every sudo-run call is audited (`nas.sudo-run`: server id, operation name, runtime, result), never arguments or output.
- **Helper runtime container** (`src/nas/command.js`, `shared/helper-runtime.js`): `docker run --rm -i --pull never --network none --pid host`
  with the image referenced by its pinned image ID, no published ports, and bind mounts that DockNest computes
  (`src/nas/mounts.js`) at identical paths. A comma, quote, `..`, relative path or a denied folder (`/`, `/proc`, `/sys`, `/dev`, `/etc`,
  `/run`, `/boot` except the Unraid template folder, `/root/.ssh`) is refused. Only `domain-routes` and `restore-test-run` get `--network host`.
  Until a release sets `HELPER_RUNTIME_IMAGE_ID`, the container runtime refuses to run.
- **Readiness** (`src/nas/readiness.js`, `inspectNas` in `src/nas/service.js`): NAS version, identity and sudo, helper runtime,
  Docker version, staging folder on persistent storage with free space, Unraid key persistence and the `/mnt/user` hard-link note.
  Results become server capabilities: `nas`, `helperRuntime`, `stagingBase`, `sshIdentity`.

## Connecting and staging

- **Connect** (`POST /api/servers/connect`, `src/nas/connect.js`): root works as before. A non-root user is accepted only when the read-only check detects a NAS, the readiness check is green and `sudo -n` works; otherwise the answer is 409 with the one fix. The helper test then runs with sudo and must report uid 0. Helper answers can never set the NAS facts.
- **Staging base on the helper** (`remote/helper/staging.py`, standard library): the `test` operation takes the stored `stagingBase`, creates it (0700), refuses links, shallow folders and memory filesystems (`tmpfs`, `ramfs`, `rootfs`), and reports `freeBytes` of that folder instead of `/`.
- **Wizard text** (`src/nas/guidance.js`, `GET /api/servers/onboarding` field `nas`): identity advice per NAS, a persistent Unraid key command (`unraidInstallCommand` in the prepare-key answer), and the Synology "SSH may have been reset after an update" login message.

## Discovery of NAS app managers (`remote/helper/nas.py`)

Read-only and only on a detected NAS; any other server's discovery answer is unchanged. Everything read from NAS files is untrusted: sizes and counts are capped, fields are validated, and nothing is run or fetched.

- **Unraid**: templates in `/boot/config/plugins/dockerMan/templates-user/my-*.xml` (64 KB each, 500 at most; a DOCTYPE or entity refuses the file) are matched to containers by name. Each container gets `nasApp` (`manager: 'unraid-template'`, display name, WebUI text, icon URL as text, never fetched; the WebUI text is untrusted, so screens show it as text or check for an http(s) scheme first) and the template file is added to its configuration files, so a backup captures it.
- **Put back**: after an app restore succeeds on an Unraid server, the worker calls the helper operation `nas-template-restore` (only the job id). The helper reads the templates named in the verified backup manifest and writes each back only into that folder, never over a different file (`restored`, `unchanged`, `kept-existing`, `missing` or `refused`). The result keeps only those statuses (`result.nasTemplates`); a failure is a note, never a failed restore.
- **Unraid Compose Manager** plugin projects (`/boot/config/plugins/compose.manager/projects/<name>`) are named read-only from a container's Compose label (`manager: 'unraid-compose-manager'`); DockNest does not capture or restore the plugin's own files.
- **Synology**: Container Manager projects (`/volume<N>/docker/<project>`) from a container's Compose labels (`manager: 'synology-project'`).
- **TrueNAS SCALE 24.10 and newer**: apps from `/mnt/.ix-apps/app_configs/<app>` Compose labels (`manager: 'truenas-app'`). DockNest never calls `midclt`. Older SCALE is refused with the message about Kubernetes.

## Helper runtime image (NAS without Python)

- **Image**: `helper-runtime/Dockerfile`, Alpine pinned by digest, Python 3, the Docker CLI and tar. linux/amd64 only. It runs as root on purpose (the helper needs the Docker socket and root file access, which are root-equivalent anyway), with no network unless the operation needs it, no published ports, and it exits after each call.
- **Build**: `scripts/build-helper-runtime.sh` builds it once, saves `helper-runtime.tar`, loads it fresh and proves it: image ID equals the ID named in the tar, DockNest label, amd64, Python 3.9+, Docker CLI, tar, and no network interface. The CI job `helper-runtime` runs it and then builds the DockNest image to check that the shipped tar matches the pin. The release workflow runs it before the DockNest image build. No secrets are used and the image is not pushed on its own.
- **Pin**: `scripts/pin-helper-runtime.js` writes the image ID and the tar SHA-256 into `shared/helper-runtime.js` of that build only. The committed file keeps `null`, so a source build refuses the container runtime and uses the host runtime only.
- **Load**: before a call on a container-runtime server, DockNest checks `docker image inspect` for the pinned ID. If it is missing, the tar is checked against the pinned SHA-256 and streamed to `docker load` over the same SSH connection (`sudo -n -- docker load` for a sudo user), then the loaded image must report exactly the pinned ID. Older DockNest-labelled runtime images are removed afterwards. Nothing is pulled and no tag is trusted. The ID is a hash of the image's configuration and layers as `docker save` writes it (the classic image store); a server whose Docker reports another kind of ID fails the check and is refused, never trusted.
- **Mounts** (`src/nas/runtime-prepare.js`): computed by DockNest from the server's staging base, the request's config folders and the bind mounts Docker reports for the app's containers, at identity paths, and checked against the deny-list. Calls that only look (discovery, tests, readiness) skip a folder the deny-list refuses; every other call is refused as a whole.
- **Limits**: operations that use fixed `/var/lib/docknest` and `/var/lib/docker-backup-manager` folders are not yet pool-aware, so backups, restores and moves through the container runtime still need the staging-base work and a real NAS check before they are supported. `docker` is looked up on the `sudo` PATH (Synology's `/usr/local/bin` is not yet handled).

## Not in this change

Pool-aware staging for every helper operation through the container runtime, the Synology Docker path, and the UI. Real NAS checks (TrueNAS lab, Unraid) are still pending.
