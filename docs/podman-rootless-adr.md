# ADR: Podman and rootless Docker

Status: proposed for 3.0.0. Related: [support-matrix.md](support-matrix.md), [remote-helper.md](remote-helper.md),
[backup-format.md](backup-format.md), [moving-sites.md](moving-sites.md).

## Problem

A growing share of self-hosters run containers without a root daemon: rootless Docker for safety, or Podman (Fedora,
RHEL, AlmaLinux, openSUSE, Debian 13) with Compose files or quadlets. DockNest only talks to the rootful Docker socket,
so these apps are invisible, or worse, half visible.

## Users

- Owners of RHEL-family servers where Podman is the default engine.
- Security-minded owners who run rootless Docker or rootless Podman under one service user.
- Owners who moved to quadlets (systemd-managed Podman containers).

## Audit

- The helper runs as **root** over SSH (`os.geteuid()==0` checks in backup, restore, install, launch) and calls the
  `docker` CLI through `common.docker()` (`run(['docker', ...])`). There is no engine abstraction.
- `discovery.engine_rootless()` reads `docker info` security options and returns `rootless`, `userns` or `none`; it is
  used for the hardening "Runs as root" check and the Move preflight `owner-map` warning
  (`src/moves/preflight.js`). It only sees whichever daemon root's `docker` talks to.
- `edit.py` and `discovery.engine_socket` already know `podman.sock` and `/run/user/<uid>/...` paths, only to refuse
  mounting engine sockets.
- `restore_gaps.py` lists `podman` among Docker commands.
- Backups record numeric owners as stored on disk (GNU tar / tarfile with numeric IDs). The manifest has
  `formatVersion` (2 since incremental backups); 2.11 and older refuse format 2 with "Unsupported or incomplete backup".
- Restore tests use `docker create` with memory and CPU limits and an isolated network.

## Decisions

1. **Root SSH stays the trust model.** DockNest does not log in as the rootless user. Root reaches every engine:
   - Docker rootful: `docker` (unchanged).
   - Docker rootless: `docker --host unix:///run/user/<uid>/docker.sock`.
   - Podman rootful: `podman`.
   - Podman rootless: `runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/<uid> HOME=<home> podman ...`.
   A new helper module `runtime.py` (added to `HELPER_MODULES` after `common`) owns this: `Runtime(engine, rootless,
   user, uid)` with `cli(*args)`, `inspect`, `volume_path(name)`, `compose(*args)`, `stop_unit / start_unit` and
   `id_map()`. `common.docker()` becomes `RUNTIME.cli()` with the default runtime equal to today's behaviour, so the
   refactor ships first with no behaviour change, proven by the existing tests.
2. **Discovery lists engines, not just containers.** The `discover` operation probes, read-only and without starting
   anything: the rootful Docker socket; `podman` as root; for each user in `/etc/subuid` whose home holds
   `~/.local/share/docker` or `~/.local/share/containers/storage`, the running rootless Docker socket and rootless
   Podman (`podman ps -a` runs without a service). Users without that storage folder are skipped, so discovery never
   creates files in a home. Each found container carries `runtime`. The Add app screen groups by engine ("Podman,
   user app"). Server capabilities gain `engines: [{ engine, rootless, user, uid, version, cgroupDelegated }]`.
3. **One app, one engine.** An app's containers must all be in one runtime; picking containers from two is refused
   ("Shop's containers run in two engines. Make two apps."). The runtime is stored in the site config as
   `runtime: { engine: 'docker'|'podman', rootless: true|false, user?, uid? }`; missing means rootful Docker.
4. **Volumes and paths.** Volume data is read from the engine's own answer (`volume inspect` Mountpoint), which gives
   `~/.local/share/docker/volumes/<v>/_data` and `~/.local/share/containers/storage/volumes/<v>/_data` (rootless) or
   `/var/lib/containers/storage/volumes/<v>/_data` (rootful Podman). The existing mount-table checks and nested-mount
   detection apply unchanged. Only the `local` volume driver is supported, as today.
5. **Owners and the user namespace.** Root reads files with their real on-disk IDs, so same-server restores are exact
   with no mapping. The manifest records the mapping at backup time: `idMap: { uid, gid, subuid: [start, count],
   subgid: [start, count] }` (rootless) or the container's `IDMappings` (Podman `--userns=auto`, `--uidmap`).
   On restore or Move to a server or user with a different mapping, the helper translates each tar member while
   extracting: the user's own ID to the target user's ID; an ID inside the source subuid range to the same offset in
   the target range. An ID outside both, or an offset beyond the target range, refuses the restore and names the first
   file ("A file is owned by an ID the new user cannot map"). `podman unshare chown -R` was considered and rejected:
   it runs as the user, cannot fix files the user cannot see, and rewrites every file a second time.
6. **Stopping managed containers.** Podman containers under systemd (quadlets, `podman generate systemd` units, label
   `PODMAN_SYSTEMD_UNIT`) restart when stopped by `podman stop`. The helper stops and starts the unit instead
   (`systemctl stop <unit>` or `systemctl --user -M <user>@ stop <unit>`), and checks the unit is inactive before the
   copy. A container with `--restart=always` outside systemd is stopped with `podman stop` as today.
7. **Compose and quadlets.**
   - Docker rootless Compose: `docker compose` with the rootless host, same labels as today.
   - Podman Compose: `podman compose` (which runs the installed provider). Project labels
     `com.docker.compose.project` (docker-compose provider) or `io.podman.compose.project` (podman-compose) are both
     read. podman-compose's pods (`--in-pod`) are recreated by `compose up`, not by hand.
   - Quadlets: the `.container`, `.volume`, `.network` and `.pod` files of the app (from
     `/etc/containers/systemd/` or `~/.config/containers/systemd/`, found from the unit's `SourcePath`) are captured as
     configuration files. Restore writes them back, runs `daemon-reload` and starts the units. Generated files under
     `/run` are never captured.
8. **Backup format.** Backups of any runtime other than rootful Docker are written as `formatVersion: 3` with
   `runtime` and `idMap`. 2.16.x refuses format 3 with "Unsupported or incomplete backup", so an older release can never
   restore a rootless backup as root-owned rootful containers. Rootful Docker backups keep format 2, byte-identical.
9. **Restore tests.** Run in the same runtime as the app on the test server (a rootless app is tested rootless, under
   the same user name on the test server, which must exist with a subuid range). Memory and CPU limits need cgroup v2
   with `memory` and `cpu` delegated to the user (`cgroup.controllers` of the user slice); without them the test is
   refused ("This server cannot limit memory for user apps, so DockNest will not test there"), never run unlimited.
   Rootless network isolation uses an internal network; internet mode uses the engine's default (pasta or
   slirp4netns). The reaper knows the runtime of each test it may need to clean.
10. **Moves.** Allowed between any two runtimes of the same engine kind (rootless to rootful Docker and back, Podman
    rootless to rootful) with ID translation from decision 5. Docker to Podman or back is refused in 3.0.0 (different
    create flags and network model). Preflight blocks a rootless target when the app publishes ports below
    `net.ipv4.ip_unprivileged_port_start`, and warns when the target user has no linger (`loginctl enable-linger`),
    because the app would stop when that user's last session ends.
11. **Refused with a plain reason** (each a fixed message and a test):
    Podman pods made by hand (`podman pod create`) or `podman kube play`; Podman machine, Docker Desktop and any non-Linux
    host; containers whose engine runs as a user with no subuid range; custom `--uidmap` across servers (same server is
    fine); non-`local` volume drivers; an app spread over two engines; Docker to Podman moves; Self-heal, Safe Edit and
    Launch on non-rootful-Docker runtimes ("available for rootful Docker only in this release").

## API

- `GET /api/servers/:id` capabilities gain `engines[]`. Discover results gain `runtime` per container.
- Site create and update accept `config.runtime` (validated against the server's engines at save).
- No new endpoints.

## Helper changes

New `runtime.py`; `common.docker()` routed through it; `discovery.py` engine probe; `backup.py` and `restore.py` read
volume paths from the runtime and write or apply `idMap`; `restore_test.py` and the reaper take the runtime;
`move.py` preflight facts gain linger, port floor and subuid ranges. Python standard library only.

## Security and privacy

- `runuser` is called with a fixed argv; the user name and uid come from `/etc/passwd` and `/etc/subuid`, are
  validated (`^[a-z_][a-z0-9_-]{0,31}$`, numeric uid >= 1000), and must match the socket owner. No shell is used.
- Root talking to a user's socket gives that user's containers nothing new; DockNest already holds root.
- ID translation never maps a file to root (0) on the target unless it was the namespace root of the source user, which
  maps to the target user, not to host root. A test asserts no restored file is owned by host uid 0 for rootless apps.
- Security review by a separate reviewer (Opus) is required for `runtime.py`, ID translation and unit stop/start.

## Upgrade safety

- No migration. Existing apps have no `runtime` and stay rootful Docker; their backups stay format 2.
- `docker()` refactor first, with the full existing helper test suite as the proof of no change.
- Downgrade: 2.16.x ignores `config.runtime`, finds no such containers under rootful Docker and fails the backup with
  "container not found"; it refuses format 3 backups. Nothing is restored wrongly.

## Test plan

- Unit (`remote/test_runtime.py`): argv per runtime, subuid parsing, ID translation table (edges: start, start+count-1,
  out of range, root), unit detection from labels, refusal messages.
- Linux CI on Ubuntu runners (new job `rootless-integration`, matrix): rootless Docker (`dockerd-rootless-setuptool.sh`
  for a test user) and Podman 4.x/5.x rootful and rootless (Ubuntu's `podman` package), each running backup, restore on
  the same server, restore to a second user with a different subuid range (ID translation), a restore test with limits,
  one Compose app and one quadlet app. Runs once in the combined integration batch.
- Live check: one rootless Podman app on a spare VM of the owner's (Fedora or AlmaLinux). Not account-gated; done by
  the build lead in a local VM.

## PR split

1. `runtime.py` refactor, no behaviour change (security review, Opus).
2. Discovery of engines + site `runtime` + UI grouping data (backend).
3. Backup/restore for rootless Docker and Podman with `idMap`, format 3, unit stop/start (security review, Opus).
4. Restore tests and reaper per runtime, cgroup delegation check (security review, Opus).
5. Moves across runtimes, preflight facts.
6. UI: engine grouping in Add app, runtime badge, refusal reasons (after board approval).
