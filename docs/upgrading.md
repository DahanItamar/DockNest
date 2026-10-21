# Upgrading DockNest

This page covers upgrades and rollbacks for a server installed with `git clone`, `scripts/setup.js` and `docker compose up -d --build`. It also lists what stays stable between versions.

Upgrades never move, rename or delete your volumes, secrets, certificates, site configuration or remote backups. Before the metadata schema changes, DockNest writes a snapshot of the database.

## Upgrade with one command

From the DockNest checkout on the server:

```sh
scripts/upgrade.sh                    # newest final release
scripts/upgrade.sh --version v2.1.0   # a specific release
scripts/upgrade.sh --dry-run          # show the plan only
```

**First upgrade from v2.0.0.** v2.0.0 does not include this script. Fetch it from the target release and run it from the checkout:

```sh
git fetch --tags
git show v2.1.0:scripts/upgrade.sh > /tmp/docknest-upgrade.sh
sh /tmp/docknest-upgrade.sh --version v2.1.0
```

The script:

1. Refuses to continue if tracked files were edited (see [Customising without conflicts](#customising-without-conflicts)), if `data/master.key` or `data/setup.token` is missing, if the target release cannot upgrade from your version (`minUpgradeFrom`), or if Compose configuration is invalid.
2. Fetches release tags and shows the current and target versions.
3. Sets the deployment hold (`scripts/deployment-preflight.js hold`) so no new backups or restores start. It waits up to `--wait` seconds (default 600) for queued or running jobs, then stops. `--force` continues anyway; interrupted jobs then need recovery review.
4. Copies `.env`, `compose.override.yaml`, `data/master.key` and `data/setup.token` to `data/upgrade-backups/<time>-<from>-to-<to>/` with mode 0700. These copies are never deleted automatically.
5. Checks out the release tag, then builds the new image (or pulls it in [image mode](#use-the-published-image)) while the old release keeps serving.
6. Stops the worker, which finishes in-flight work first, then starts the new API and worker. On first start the new code migrates the metadata after taking a snapshot.
7. Waits up to `--timeout` seconds (default 300) for `GET /api/version` to report the target version and for the worker to run. Then it lifts the hold.

If the new release does not become healthy:

- **Schema unchanged:** the script checks out the previous commit, starts it again (image mode: the exact image recorded before the switch), lifts the hold and exits with code 4. No data changed.
- **Schema already migrated:** the script does not guess. It exits with code 5, keeps the hold, and prints the exact [rollback](#rolling-back) commands.

Any other failure after the hold is set (a step that errors, Ctrl-C, a signal) is handled the same way: the hold is released, the checkout and containers return to the previous release when the metadata is provably unchanged, and the status file ends with `ok: false`. It never stays at `ok: null`. A refusal after the hold (for example, no space for the configuration backup) also lifts the hold.

Reinstall boot recovery afterwards, if you use it. See [Boot recovery after upgrades](#boot-recovery-after-upgrades).

### Options and exit codes

| Option | Meaning |
| --- | --- |
| `--version vX.Y.Z` | Target tag. Default: the newest final `vX.Y.Z` tag (never a pre-release). |
| `--non-interactive` | Do not ask for confirmation. Implied when stdin is not a terminal. |
| `--allow-data-rollback` | Allows a downgrade that restores an older metadata snapshot. Required with `--non-interactive`. |
| `--status-file PATH` | Write progress as JSON, replaced atomically at each phase. |
| `--force` | Continue when jobs are still queued or running after `--wait`. |
| `--wait SECONDS` / `--timeout SECONDS` | Idle wait (default 600) and health wait (default 300). |
| `--dry-run` | Read-only plan: no fetch (it uses the tags already in the checkout), no hold, no status file, no containers started apart from reading the schema version. |

| Code | Result |
| --- | --- |
| 0 | Upgraded, or already running the target. |
| 1 | Usage error. |
| 2 | Refused before changing anything (edited files, missing secrets, unknown tag, unsupported path, downgrade without a matching snapshot, cancelled). |
| 3 | Jobs were still queued, running or awaiting recovery review. Nothing changed. |
| 4 | Failed before the schema changed. The previous release was restored automatically. |
| 5 | Failed after the schema migrated, or failed unexpectedly where the metadata could not be proven unchanged. The hold stays on. Roll back manually with the printed commands. |
| 6 | The automatic return to the previous release also failed. |

The status file is a single JSON object:

```json
{"phase":"health","from":"2.0.0","to":"2.1.0","startedAt":"2026-10-21T08:00:00Z","updatedAt":"2026-10-21T08:02:10Z","ok":null,"error":null,"rollbackHint":"git checkout <commit> && docker compose up -d --build && ..."}
```

`phase` moves through `preflight`, `fetch`, `idle`, `backup`, `checkout`, `build`, `stop`, `restore-snapshot` (downgrades only), `start`, `health`, `rollback` (only after a failure) and `release`, and ends at `done` or `failed`. `ok` stays `null` while the script runs and is `true` or `false` at the end. The file has mode 0644 and contains no secrets.

## Manual upgrade

```sh
git status --short --untracked-files=no                     # must print nothing
docker compose exec api node scripts/deployment-preflight.js hold
cp -p .env data/master.key data/setup.token /secure/backup/  # plus compose.override.yaml if you have one
git fetch --tags && git checkout v2.1.0
docker compose build
docker compose stop worker
docker compose up -d
docker compose logs --tail=50 api                           # look for "metadata schema migrated"
curl -fsS http://127.0.0.1:${HOST_PORT:-3000}/api/version     # {"version":"2.1.0","schemaVersion":2}
docker compose exec api node scripts/deployment-preflight.js release
```

Do not run `git pull` on a release checkout. Releases are tags, so the checkout is a detached HEAD.

## Rolling back

**Compatible schema (no data loss).** A migration marked `compatible: true` only adds tables or indexes that older code ignores. Migration 2 (`boot_recovery_installs`) is one. When every migration newer than the target release is compatible, the older release runs on the migrated database as is: `scripts/upgrade.sh --version <older tag>` checks out the tag, rebuilds and starts it, with no snapshot restore and no `--allow-data-rollback`. This is how the common 2.1 to 2.0.0 rollback works. By hand: check out the previous tag and run `docker compose up -d --build`. v2.0.0 has no `/api/version`; use `/healthz` instead. Releases from 2.1 onward record the oldest usable schema (`schema_compat_floor` in `settings`) and start on a newer, compatible database; v2.0.0 has no schema check at all.

**Incompatible schema.** If any newer migration is not compatible, an older release refuses to start. It logs `DockNest metadata schema vN is newer than this release understands` and names the snapshot to restore. Snapshots live in `DATA_DIR/upgrade-snapshots` (inside the `docker-backup-manager_state` volume) as `state-v<from>-to-v<to>-<UTC time>.sqlite`. The newest five, plus the newest of every distinct from/to pair, are kept. A failing migration under a restart policy reuses one snapshot instead of copying the database on every boot, and a snapshot needs 1.2 times the database size plus 64 MiB of free space, otherwise the upgrade stops before changing anything. Restoring a snapshot discards every job, backup record and setting change made after it. Backup files on storage are not touched, but backups taken since then are no longer listed. `scripts/upgrade.sh --version <older tag> --allow-data-rollback` does all of this for you. To do it by hand:

```sh
docker compose stop api worker
docker compose run --rm --no-deps --entrypoint /bin/sh worker -ec 'ls -l /data/upgrade-snapshots'
docker compose run --rm --no-deps --entrypoint /bin/sh worker -ec '
  cd /data && keep=upgrade-snapshots/pre-rollback-$(date +%s) && mkdir -m 700 "$keep"
  for f in state.sqlite state.sqlite-wal state.sqlite-shm; do [ ! -e "$f" ] || mv "$f" "$keep/"; done
  cp upgrade-snapshots/state-v0-to-v2-20261021T080000000Z.sqlite state.sqlite && chmod 600 state.sqlite'
git checkout v2.0.0 && docker compose up -d --build
docker compose exec api node scripts/deployment-preflight.js release
```

Keep the `pre-rollback-*` folder until you have checked the result. The upgrade backup folder holds the `.env` and secrets that belong to the previous release.

## Use the published image

Releases from 2.1 onward are published as `ghcr.io/dahanitamar/docknest` with the tags `X.Y.Z`, `X.Y`, `X` and `latest`. Pre-releases get only their exact tag. Building from source stays the default. To use the image, add `DOCKNEST_IMAGE=ghcr.io/dahanitamar/docknest:2.1.0` to `.env` and use the override in `compose.override.example.yaml` (Docker Compose 2.24 or later). Use a tag, not a digest. To upgrade, run `scripts/upgrade.sh --version v2.1.1`: the script records the current tag and image ID in the upgrade backup, switches only the tag for its own `pull` and `up` commands, and writes the new tag to `.env` after the release is healthy. If the start fails, it returns to the recorded image ID (`up --pull never`), not to whatever tag `.env` names. The signature is not verified by the script; use the cosign command below when you want that.

The release workflow runs only for a tag whose commit is on `main` and has a successful `Verify` run, and publishes `linux/amd64` only. On ARM hosts keep building from source.

Every pushed digest is signed with cosign keyless signing from the release workflow. Verify an image before using it:

```sh
cosign verify ghcr.io/dahanitamar/docknest:2.1.0 \
  --certificate-identity https://github.com/DahanItamar/DockNest/.github/workflows/release.yml@refs/tags/v2.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Each GitHub Release also includes `docknest-release.json`:

```json
{"version":"2.1.0","schemaVersion":2,"minUpgradeFrom":"2.0.0","image":{"name":"ghcr.io/dahanitamar/docknest","digest":"sha256:…"},"notes":"docs/releases/2026-11-02-v2.1.0.md"}
```

Release notes are also bundled in the image under `docs/releases/`. Name new notes `YYYY-MM-DD-vX.Y.Z.md`. A `vX.Y.md` file also covers the `X.Y.0` release.

DockNest never checks for updates on its own. The **About** section in preferences shows the running version and links to the releases page.

## Boot recovery after upgrades

Most remote operations stream the current helper over SSH, so they update automatically. Boot recovery is the exception: installing it copies `remote/helper.py` and `remote/boot_recovery.py` onto the host, and those copies go stale after an upgrade. DockNest records the SHA-256 of the installed bundle. Site state (`GET /api/state`) and `GET /api/sites/:id/boot-recovery` report `bootRecoveryOutdated: true` when the copy differs from the running release. This includes installs made before fingerprints were recorded. Upgrades never connect to your hosts. After each upgrade, reinstall boot recovery on the affected sites (`POST /api/sites/:id/boot-recovery`, administrators only) once no work is active. The dashboard does not show this flag yet.

## Customising without conflicts

The upgrade script refuses to run if tracked files are edited, because an upgrade would overwrite those edits. Put your changes where git never looks:

- `.env` for `APP_ORIGIN`, `SECURE_COOKIES`, `HOST_PORT`, `APP_DOMAIN`, `DOCKNEST_IMAGE` and other variables.
- `compose.override.yaml` for Compose changes such as ports, extra mounts, resource limits or image mode. Copy `compose.override.example.yaml` to start. Compose merges it automatically, and git ignores it.
- `data/` for secrets.

If `git status` lists a modified file, move the change into one of these, then run `git restore <file>`.

## Stability contract

DockNest follows [Semantic Versioning](https://semver.org/). Within a major version (2.x), the following stay compatible. A new release may add to them but will not rename, remove or reinterpret them.

| Area | Stable items |
| --- | --- |
| Environment variables | `APP_ORIGIN`, `SECURE_COOKIES`, `HOST_PORT`, `APP_DOMAIN`, `PORT`, `HOST`, `NODE_ENV`, `DATA_DIR`, `BACKUP_DIR`, `BACKUP_STORAGE`, `MASTER_KEY_FILE`, `SETUP_TOKEN_FILE`, `ALLOW_LOCAL_BACKUP_STORAGE`, `STORAGE_HOST`, `STORAGE_PORT`, `STORAGE_USERNAME`, `STORAGE_HOST_KEY_SHA256`, `STORAGE_PRIVATE_KEY_FILE`, `STORAGE_PASSWORD_FILE`, `STORAGE_ROOT`, `STORAGE_CAPACITY_BYTES`, and the optional `DOCKNEST_IMAGE`. |
| Secret files | `./data/master.key` (base64 32-byte key) and `./data/setup.token`, mounted as the Compose secrets `master_key` and `setup_token` at `/run/secrets/master_key` and `/run/secrets/setup_token`. |
| Compose | Project `docknest`; services `api`, `worker` and `proxy` (profile `https`); volumes `docker-backup-manager_state`, `docker-backup-manager_caddy_data` and `docker-backup-manager_caddy_config` (legacy names kept on purpose, so certificates and state carry over); loopback API port `127.0.0.1:${HOST_PORT:-3000}`. |
| `DATA_DIR` layout | `state.sqlite` with its `-wal` and `-shm` files, `worker.lock`, `upgrade-snapshots/`, `manager-backups/`, `private-exports/`, and `backups/` in local mode. Snapshot names follow `state-v<from>-to-v<to>-<UTC>.sqlite`. |
| Sessions | The `dbm_session` cookie and the `x-csrf-token` header. An upgrade keeps valid sessions, except the one-time v2.0.0 cleanup of legacy sessions without timestamps. |
| Site configuration | The JSON fields accepted by `POST /api/sites`: `kind`, `documentRoot`, `containers`, `stagingRoot`, `deliveryMode`, `sqliteIntegrityCheck`, `exclusiveSourcesConfirmed`, `stopTimeout`, `shutdownProfile`, `cleanShutdownConfirmed`, `unresolvedDependencies`, `services`, `configFiles`, `mountExclusions`, `mountExclusionsConfirmed`, `restoreReferences`, `temporaryMemoryFolders`, `composeFiles`, `externalReferencesConfirmed`, `maintenanceRequired`, `maintenanceProbeOrigin`, `maintenancePublicUrl`, `domains`, `healthUrl` and `maintenance`. Saved configurations keep loading. New fields always get defaults. |
| Public endpoints | `GET /healthz` returns `{status}` and `GET /api/version` returns `{version, schemaVersion}`. Neither needs a session. |
| Backup formats | DBM1 encrypted payloads (`scripts/decrypt-backup.js`), manifests and recovery kits written by any 2.x release stay readable by later 2.x releases. |

Not covered: internal module APIs, database table layout (use the API), the CSS and markup of the dashboard, and authenticated JSON fields not listed above.

### Deprecation policy

- A deprecated item keeps working for at least one minor release. While it is deprecated, DockNest logs a warning at startup or on use, and the CHANGELOG lists it under **Deprecated**.
- Breaking changes happen only in a new major version. That release includes a migration guide in `docs/releases/` and sets `minUpgradeFrom` when intermediate releases are required.
- Schema migrations only move forward. A release never edits or renumbers a migration that has already shipped. Patch releases add migrations only for urgent fixes, and the release notes say so.
- A downgrade across incompatible migrations needs the matching pre-upgrade snapshot. Across compatible (purely additive) migrations, and within the same schema, downgrades are safe.

## Schema migrations (contributors)

`src/migrations.js` holds an ordered list of migrations. The database version is stored in `PRAGMA user_version`, which lives in the database header. It changes in the same transaction as the DDL and survives `VACUUM INTO` and the backup API. A v2.0.0 database reads as 0, so no extra `schema_migrations` table is needed.

On startup, `src/db.js` takes `BEGIN IMMEDIATE` with a long busy timeout, so when the API and worker start together only one of them migrates. If any migrations are pending on a non-empty database, it first writes a `VACUUM INTO` snapshot through a second connection. It then applies the pending migrations, sets `user_version` and commits. A failed migration rolls back completely. A version higher than the code knows stops startup.

Migration 1 (`baseline`) is the exact v2.0.0 startup schema. It is repeatable: it runs on every start, as v2.0.0 did. Only additive `CREATE ... IF NOT EXISTS` statements may be appended to it. Every other change needs a new numbered entry. Add `compatible: true` only to an entry that creates new tables or indexes and changes nothing existing; anything that alters, drops, rewrites or reinterprets existing data must not carry it, because older releases would then misread the data. Keep each entry on one line starting with `{ version: N,`, because `scripts/upgrade.sh` reads the highest number and the compatible flags from that pattern (`tests/upgrade-script.test.js` checks it against the real file). A failed snapshot leaves no `.partial` file, and stale ones are removed at the next start. `scripts/release-manifest.js` imports `schemaVersion` directly. Tests: `tests/migrations.test.js` (unit) and `npm run test:upgrade -- vX.Y.Z` (the real released code against the current API, run by the CI `upgrade` job for every final tag).

## In-app updater request contract (planned)

The containers never get the Docker socket. A future in-app updater will use a host-side root service, installed once with `sudo scripts/install-updater.sh` (not part of this release). The service watches a request file in the state volume and runs `scripts/upgrade.sh`. Planned contract:

| Item | Contract |
| --- | --- |
| Directory | `DATA_DIR/updater/` (`/data/updater` in the containers; on the host, the `docker-backup-manager_state` volume's `_data/updater`). Owned by uid 1000, mode 0700. |
| Request | `updater/request.json`, mode 0600, written by the API as uid 1000. The API writes `request.json.<id>.tmp`, syncs it, then renames it so the file appears complete. The API accepts only one pending request, and only when `status.json` is absent or has ended (`ok` is not `null`). |
| Fields | `{"schema":1,"id":"<uuid>","action":"upgrade"|"downgrade","version":"vX.Y.Z","allowDataRollback":false,"requestedBy":"<user id>","requestedAt":"<ISO time>"}`. No other fields. Values are never passed through a shell. |
| Reader | A root systemd path unit and service. It opens the file with `O_NOFOLLOW` and requires a regular file owned by uid 1000. It rejects unknown fields, a `version` not matching `^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`, tags missing from `origin`, and versions below `minUpgradeFrom`. It moves the request to `updater/processing/<id>.json`, then runs `scripts/upgrade.sh --non-interactive --version <version> [--allow-data-rollback] --status-file DATA/updater/status.json` from the checkout, one request at a time. Afterwards it moves the request to `updater/done/<id>.json` with the exit code added. |
| Status | The script writes the status file with an exclusive, unpredictable temporary name created together with its contents in a directory owned by the script's user, mode 0644, then renames it; it refuses to write if the file or its directory is a symlink or not owned by that user. So the directory must be owned by the account running the script (root for the host service), not by uid 1000; see the requirements below. The API only reads it. The API restarts during an upgrade, so the dashboard must poll `/api/version` and the status file through the new API. |
| Trust | The request only asks for an upgrade; the host service decides. Treat the volume as writable by a possibly compromised API: never follow links, never run values from the request, and require `allowDataRollback` before any downgrade that restores a snapshot. |

### Known requirements for the 2.2.0 updater

An independent review found these gaps in the contract above. Treat everything in a directory owned by uid 1000 as attacker-controlled, including the directory, its parents under `_data/` and every name inside. The 2.2.0 implementation must close all of them.

1. **Path components can be swapped for symlinks.** `O_NOFOLLOW` protects only the final component. `updater`, `processing/` and `done/` are owned by uid 1000, so the API could replace them with symlinks (for example to `/etc/cron.d`) between a check and a `rename`. Open the volume path through a descriptor chain (`O_PATH|O_DIRECTORY|O_NOFOLLOW`, or `openat2` with `RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH`) and do every operation with `*at()` calls relative to it.
2. **Validate-then-use race.** The API owns the file and can rewrite it after the root reader validated it. Read once from the open descriptor into memory (size cap such as 4 KiB), validate that copy, write a root-owned record under a root-owned directory such as `/var/lib/docknest-updater/` (not the 1000-owned `processing/`), use only the in-memory values afterwards, then `unlinkat` the original.
3. **Other file-type attacks.** After opening, check with `fstat`: a regular file, `st_uid == 1000`, `st_nlink == 1` (no hardlinks), size cap. Open with `O_NONBLOCK` so a FIFO cannot stall the service. Reject sparse or huge files.
4. **`id` is not constrained.** Only `version` has a regex, yet `id` becomes a file name (`processing/<id>.json`, `done/<id>.json`), so `../` or an absolute path escapes. Require a canonical UUID and build names from the parsed value. Write results into a root-owned directory and let the API read them through a read-only view; writing `done/<id>.json` as root into a 1000-owned directory has the symlink problem of item 1.
5. **`allowDataRollback` is attacker-supplied.** A compromised API sets it itself, so requiring it protects nothing. The root service should refuse any downgrade that restores a snapshot, or require a confirmation that never touches the volume (a local CLI step or a one-time token). Decide explicitly whether `action: "upgrade"` with an older version is allowed; `scripts/upgrade.sh` permits compatible downgrades silently.
6. **Version trust.** The regex allows pre-release suffixes, so a request can select a pre-release tag if one exists on `origin`. The script trusts the `origin` in `.git/config` and does not check tag signatures, so a force-moved or rogue tag leads to building attacker-chosen code as root. Pin the expected remote URL in the service configuration, accept final releases only unless an administrator enabled pre-releases, require `git verify-tag` or a match with the signed `docknest-release.json` / cosign identity before building, and check that the tag commit is an ancestor of `origin/main`.
7. **Least privilege.** The script needs only the Docker socket and the checkout. A dedicated user in the `docker` group that owns the checkout is better than root and removes the `safe.directory` relaxation and the root-follows-symlinks class of bugs. The docker group is root-equivalent anyway, so this is about not adding exposure, not a security boundary.
8. **Denial of service and replay.** A path unit on a directory the API can modify can be triggered at will. Add `StartLimitBurst`, a single-instance lock and a cool-down. Add a monotonic `requestedAt` or nonce check against the last `done` record so a replayed old request cannot run again. The rule "only when `status.json` has ended" is enforced by the component the contract does not trust, so the root service must enforce its own queueing.
9. **Status.** `status.json` must be written by the root service into a root-owned location, and the API must treat its contents as untrusted when rendering them.
