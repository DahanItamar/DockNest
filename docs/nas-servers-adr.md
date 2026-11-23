# ADR: NAS servers (Unraid, Synology DSM, TrueNAS SCALE)

Status: proposed for 3.0.0. Related: [remote-helper.md](remote-helper.md), [server-connection.md](server-connection.md),
[support-matrix.md](support-matrix.md), [podman-rootless-adr.md](podman-rootless-adr.md).

## Problem

A large part of self-hosting runs on NAS systems, not plain Linux servers. DockNest's helper needs host Python 3.9+,
root SSH and the Docker CLI on a normal Linux layout. Unraid has no persistent Python, Synology DSM ships an older
Python, TrueNAS SCALE has a read-only system. NAS app managers (Unraid templates, Synology Container Manager projects,
TrueNAS apps) are not recognized, so owners get a wall of "plain container" apps with odd paths.

## Users

- Home owners with an Unraid box (appdata on `/mnt/user/appdata`, apps from Community Applications templates).
- Synology owners using Container Manager projects in `/volume1/docker`.
- TrueNAS SCALE 24.10+ owners with catalogue apps or custom Compose apps.

## Audit

- `src/ssh.js` runs `python3 -c "<loader>"` for every helper call; there is no other runtime.
- The helper requires root (`geteuid()==0`) and calls `docker` via `common.docker()`; staging uses folders under the
  app's mounts or a staging base; `freeBytes` reads `/`.
- Discovery knows Compose projects and two stack managers (Portainer, Dockge) by image and paths; nothing about NAS
  app managers.
- Server onboarding (`src/server-onboarding.js`) prints a `python3` report command; readiness fails without Python.
- The image is `linux/amd64` only; NAS on ARM (many Synology models) is out of scope with it.

## Decisions

1. **Helper runtime: host Python first, pinned container second.** On connect, DockNest checks `python3` >= 3.9. If it
   is present (TrueNAS SCALE, most Linux) nothing changes. If not (Unraid, Synology DSM 7 with Python 3.8, any host
   without Python) and Docker is present, the helper runs inside a **helper runtime container**:
   - Image `docknest-helper-runtime`: Alpine with `python3`, the Docker CLI and `tar`, built in DockNest's release
     workflow, published with the release, referenced by **digest** in `shared/helper-runtime.js`. Tens of MB.
   - DockNest ships the image tar inside its own image (`/app/helper-runtime.tar`) and loads it on the server over SSH
     (`docker load`) when the digest is missing, then checks `docker image inspect` returns the pinned ID. No registry
     pull is needed, so it works offline and cannot be swapped by a registry. Old runtime images (other digests with
     the DockNest label) are removed after a successful load.
   - Each helper call runs `docker run --rm -i --network none --pid host --security-opt label=disable
     --label org.docknest.helper=1 -v /var/run/docker.sock:/var/run/docker.sock` plus **identity bind mounts**: every
     host path the call needs is mounted at the same path inside (`--mount type=bind,src=X,dst=X,bind-propagation=rslave`),
     so the helper sees host paths unchanged and no path translation exists. The mount list is computed by DockNest
     from the app's stored mounts, the Docker root dir and the staging base, and validated against a deny-list
     (`/`, `/proc`, `/sys`, `/dev`, `/boot` except the Unraid template folder below, `/etc`).
   - Network is `none` except for helper operations that need it (restore test probes, domain checks), which get
     `--network host`.
   - The same loader (`python3 -c ...`) and stdin protocol are used inside, so `src/ssh.js` only changes the command
     prefix. The helper reports `runtime: 'container'` in its result.
   Rejected: installing Python on the NAS (Unraid's root filesystem is in RAM and lost on reboot; changes to DSM and
   TrueNAS are unsupported by the vendors and undone by updates); a static Python build streamed per call (large,
   needs a writable exec location, still no Docker CLI on some hosts).
2. **Staging on the pool, never in RAM.** Unraid's `/` and `/tmp` live in RAM. The staging base on a NAS is a DockNest
   folder on persistent storage, chosen at connect and shown to the owner: Unraid `/mnt/user/system/docknest` (or
   `/mnt/cache/system/docknest` when a cache pool exists), Synology `/volume1/@docknest`, TrueNAS
   `/mnt/<pool>/.docknest`. `freeBytes` reads that folder, not `/`.
3. **NAS detection** (read-only facts, in the existing `test` operation): `/etc/unraid-version`; `/etc/synoinfo.conf`
   and `/etc.defaults/VERSION`; `/etc/version` containing `TrueNAS-SCALE` plus `midclt` present. Result
   `nas: { kind, version }` in server capabilities. The server card shows the NAS name and logo text, not "Linux".
4. **Path layouts and app managers.**
   - **Unraid**: apps from Docker templates. Discovery reads `/boot/config/plugins/dockerMan/templates-user/my-*.xml`
     (name, WebUI, icon URL as text only, never fetched) and matches containers by name. Mounts are usually
     `/mnt/user/appdata/<app>`. A backup also captures the app's template XML as a configuration file; restore puts it
     back so the Unraid Docker page keeps managing the container. Compose Manager plugin projects
     (`/boot/config/plugins/compose.manager/projects/<name>/`) are read as Compose projects. `/mnt/user` is a FUSE
     union: the readiness check warns that hard links across disks are not kept and recommends `/mnt/cache` paths
     when present. Docker's data lives in `docker.img` (a loop file) or a folder; both are read through Docker.
   - **Synology DSM 7.2+**: Container Manager projects live in `/volume1/docker/<project>` with
     `compose.yaml`; the project registry is read from Container Manager's project folder (read-only). Docker data is
     `/volume1/@docker`. Docker CLI is `/usr/local/bin/docker`, added to `PATH` by the helper. Container Manager's
     Docker is older (20.10 or 24.x): features that need Docker 28 (grouped copies) are refused with the version named.
   - **TrueNAS SCALE 24.10 (Electric Eel) and newer**: apps run on Docker. Catalogue apps store their Compose files and
     metadata under `/mnt/.ix-apps/app_configs/<app>/`; custom apps under the same tree. Discovery reads them as Compose
     projects named after the app. Restore of a catalogue app restores data and recreates containers with the stored
     Compose file, then tells the owner to open the TrueNAS Apps page once so the middleware picks it up; DockNest
     never calls `midclt` to change state. **TrueNAS SCALE 24.04 and older** (Kubernetes `ix-applications`) are refused:
     "TrueNAS apps before 24.10 run on Kubernetes, which DockNest does not back up. Update TrueNAS to 24.10 or newer."
5. **SSH quirks, handled in the connect wizard text and readiness checks:**
   - Unraid: root SSH on by default. Keys added to `/root/.ssh` are lost on reboot; the wizard's command writes the key
     to `/boot/config/ssh/root/authorized_keys` (persistent) and the readiness check says when a reboot would lose it.
   - Synology: root login is off by default and DSM updates can reset `sshd_config`. The wizard explains enabling
     "SSH service", then a root key via `sudo -i`. After a DSM update, a failed login shows "Synology may have reset SSH
     after an update" instead of a generic error.
   - TrueNAS: root login is off by default since 24.04 (the `truenas_admin` user). The wizard explains enabling it for
     key-only login in System > SSH. DockNest still needs root; sudo mode is not added in 3.0.0 (open question).
6. **Readiness checks per NAS**: helper runtime ready (Python version or runtime image digest), staging folder
   persistent and writable, free space there, Docker version, key persistence (Unraid), NAS version supported. Each
   failed check names one fix.

## Data model

No migration. Server capabilities (JSON) gain `nas` and `helperRuntime: 'host' | 'container'` and
`stagingBase`. The helper runtime digest is a constant per release, not stored.

## API

- Server test and capabilities return `nas`, `helperRuntime`, `stagingBase`.
- Discover results gain `manager: 'unraid-template' | 'synology-project' | 'truenas-app'` and a display name.
- No new endpoints.

## Helper changes

`discovery.py`: NAS detection, Unraid templates, Synology projects, TrueNAS app configs. `paths.py`/`common.py`:
staging base from the request instead of a fixed default; Docker CLI path lookup. `backup.py`/`restore.py`: capture
and put back the Unraid template file. Standard library only. The helper does not know whether it runs on the host
or in the runtime container except through one fact it reports.

## Security and privacy

- The runtime container gets the Docker socket and the bind mounts, which is root-equivalent: the same power DockNest
  already has with root SSH, not more. It has no network by default, no published ports, and exits after each call.
- Image integrity: pinned digest, shipped inside the DockNest image, verified after load; never pulled by tag.
- Bind mounts are computed by DockNest and checked against the deny-list; the request cannot add mounts.
- Template icon URLs are stored as text and never fetched by the server or the browser (no tracking pixels).
- Security review by a separate reviewer (Opus) is required for the runtime container PR.

## Upgrade safety

- Servers that have Python 3.9+ keep the host runtime; nothing changes for every existing install.
- The DockNest image grows by the runtime tar (tens of MB).
- Downgrade: 2.16.x ignores the new capability fields; a NAS without Python fails its connection test there, as before.
  The runtime image left on a NAS is harmless and labelled for removal.

## Test plan

- Unit: NAS detection fixtures (file samples, no real hosts), template XML parsing (hostile XML: entities refused,
  size limits), Synology project and TrueNAS app config parsing, mount deny-list, staging base choice.
- Linux CI: a job runs the whole existing integration scenario with `helperRuntime: 'container'` on an Ubuntu runner
  with `python3` hidden from the SSH user's `PATH`, so the container runtime is proven end to end. Batched in the
  combined integration run.
- Live VMs on the owner's PC, headless, started without a window and never taking focus:
  - TrueNAS SCALE 25.x in Hyper-V (free ISO): connect, discover a catalogue app and a custom app, backup, restore,
    restore test.
  - Unraid: the 30-day trial needs a USB stick with a unique GUID, and Hyper-V cannot pass a USB stick to a VM. Plan:
    a VMware Workstation (free for personal use) VM with USB passthrough of a spare stick. **Pending live check**
    (needs a spare USB stick and the trial sign-up); work continues and Unraid stays Beta until it passes.
  - Synology: no hardware. **Beta** with a fixture-based test of the layout only.

## PR split

1. Helper runtime container image + release workflow + `shared/helper-runtime.js` + ssh.js prefix + CI job
   (security review, Opus).
2. NAS detection, staging base, readiness checks, wizard text (backend + docs).
3. Discovery for Unraid templates, Synology projects, TrueNAS apps; Unraid template capture and restore.
4. UI: NAS server card, readiness list, discover grouping (after board approval).
