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

## Not in this change

The runtime image build and release workflow, loading the image tar over SSH, passing per-call mounts from callers, the
Python-side staging base and discovery of Unraid templates, Synology projects and TrueNAS apps, and the UI. Real NAS
checks (TrueNAS lab, Unraid) are still pending.
