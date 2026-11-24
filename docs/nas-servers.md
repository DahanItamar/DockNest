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

- **Unraid**: templates in `/boot/config/plugins/dockerMan/templates-user/my-*.xml` (64 KB each, 500 at most; a DOCTYPE or entity refuses the file) are matched to containers by name. Each container gets `nasApp` (`manager: 'unraid-template'`, display name, WebUI text, icon URL as text, never fetched) and the template file is added to its configuration files, so a backup captures it.
- **Put back**: helper operation `nas-template-restore` (`archive` inside the restore job, `original` the exact template path) writes the template back only on Unraid, only into that folder, and never overwrites a different file (`restored`, `unchanged` or `kept-existing`).
- **Synology**: Container Manager projects (`/volume<N>/docker/<project>`) from a container's Compose labels (`manager: 'synology-project'`).
- **TrueNAS SCALE 24.10 and newer**: apps from `/mnt/.ix-apps/app_configs/<app>` Compose labels (`manager: 'truenas-app'`). DockNest never calls `midclt`. Older SCALE is refused with the message about Kubernetes.

## Not in this change

The runtime image build and release workflow, loading the image tar over SSH, passing per-call mounts from callers, Unraid Compose Manager projects, wiring the template put-back into the restore flow and the UI. Real NAS checks (TrueNAS lab, Unraid) are still pending.
