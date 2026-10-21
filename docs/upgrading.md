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

- **Schema unchanged:** the script checks out the previous commit, starts it again, lifts the hold and exits with code 4. No data changed.
- **Schema already migrated:** the script does not guess. It exits with code 5 and prints the exact [rollback](#rolling-back) commands.

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
| `--dry-run` | Run all checks and print the plan without changing anything. |

| Code | Result |
| --- | --- |
| 0 | Upgraded, or already running the target. |
| 1 | Usage error. |
| 2 | Refused before changing anything (edited files, missing secrets, unknown tag, unsupported path, downgrade without a matching snapshot, cancelled). |
| 3 | Jobs were still queued, running or awaiting recovery review. Nothing changed. |
| 4 | Failed before the schema changed. The previous release was restored automatically. |
| 5 | Failed after the schema migrated. Roll back manually with the printed commands. |
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

**Same schema.** Compare `schemaVersion` in the release manifests or `/api/version`. If it is equal, or the older release is v2.0.0 and the newer schema is 1, check out the previous tag and run `docker compose up -d --build`. The data stays compatible. v2.0.0 has no `/api/version`; use `/healthz` instead.

**Newer schema.** An older release refuses to start on a newer schema. It logs `DockNest metadata schema vN is newer than this release understands` and names the snapshot to restore. Snapshots live in `DATA_DIR/upgrade-snapshots` (inside the `docker-backup-manager_state` volume) as `state-v<from>-to-v<to>-<UTC time>.sqlite`. The newest five are kept. Restoring a snapshot discards every job, backup record and setting change made after it. Backup files on storage are not touched, but backups taken since then are no longer listed. `scripts/upgrade.sh --version <older tag> --allow-data-rollback` does all of this for you. To do it by hand:

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

Releases from 2.1 onward are published as `ghcr.io/dahanitamar/docknest` with the tags `X.Y.Z`, `X.Y`, `X` and `latest`. Pre-releases get only their exact tag. Building from source stays the default. To use the image, add `DOCKNEST_IMAGE=ghcr.io/dahanitamar/docknest:2.1.0` to `.env` and use the override in `compose.override.example.yaml` (Docker Compose 2.24 or later). Pin an exact version. To upgrade, change the tag in `.env`, then run `scripts/upgrade.sh --version v2.1.1`. The script pulls instead of building, and it refuses to run if the configured tag does not match the target.

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
- A downgrade across a schema change needs the matching pre-upgrade snapshot. Within the same schema, downgrades are safe.

## Schema migrations (contributors)

`src/migrations.js` holds an ordered list of migrations. The database version is stored in `PRAGMA user_version`, which lives in the database header. It changes in the same transaction as the DDL and survives `VACUUM INTO` and the backup API. A v2.0.0 database reads as 0, so no extra `schema_migrations` table is needed.

On startup, `src/db.js` takes `BEGIN IMMEDIATE` with a long busy timeout, so when the API and worker start together only one of them migrates. If any migrations are pending on a non-empty database, it first writes a `VACUUM INTO` snapshot through a second connection. It then applies the pending migrations, sets `user_version` and commits. A failed migration rolls back completely. A version higher than the code knows stops startup.

Migration 1 (`baseline`) is the exact v2.0.0 startup schema. It is repeatable: it runs on every start, as v2.0.0 did. Only additive `CREATE ... IF NOT EXISTS` statements may be appended to it. Every other change needs a new numbered entry. Keep each entry on one line starting with `{ version: N,`, because `scripts/upgrade.sh` reads the highest number from that pattern. `scripts/release-manifest.js` imports `schemaVersion` directly. Tests: `tests/migrations.test.js` (unit) and `npm run test:upgrade -- vX.Y.Z` (the real released code against the current API, run by the CI `upgrade` job for every final tag).

## In-app updater request contract (planned)

The containers never get the Docker socket. A future in-app updater will use a host-side root service, installed once with `sudo scripts/install-updater.sh` (not part of this release). The service watches a request file in the state volume and runs `scripts/upgrade.sh`. Planned contract:

| Item | Contract |
| --- | --- |
| Directory | `DATA_DIR/updater/` (`/data/updater` in the containers; on the host, the `docker-backup-manager_state` volume's `_data/updater`). Owned by uid 1000, mode 0700. |
| Request | `updater/request.json`, mode 0600, written by the API as uid 1000. The API writes `request.json.<id>.tmp`, syncs it, then renames it so the file appears complete. The API accepts only one pending request, and only when `status.json` is absent or has ended (`ok` is not `null`). |
| Fields | `{"schema":1,"id":"<uuid>","action":"upgrade"|"downgrade","version":"vX.Y.Z","allowDataRollback":false,"requestedBy":"<user id>","requestedAt":"<ISO time>"}`. No other fields. Values are never passed through a shell. |
| Reader | A root systemd path unit and service. It opens the file with `O_NOFOLLOW` and requires a regular file owned by uid 1000. It rejects unknown fields, a `version` not matching `^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`, tags missing from `origin`, and versions below `minUpgradeFrom`. It moves the request to `updater/processing/<id>.json`, then runs `scripts/upgrade.sh --non-interactive --version <version> [--allow-data-rollback] --status-file DATA/updater/status.json` from the checkout, one request at a time. Afterwards it moves the request to `updater/done/<id>.json` with the exit code added. |
| Status | `updater/status.json`, written only by the script (fresh temporary file, then rename), mode 0644, as described in [Options and exit codes](#options-and-exit-codes). The API only reads it. The API restarts during an upgrade, so the dashboard must poll `/api/version` and the status file through the new API. |
| Trust | The request only asks for an upgrade; the host service decides. Treat the volume as writable by a possibly compromised API: never follow links, never run values from the request, and require `allowDataRollback` before any downgrade that restores a snapshot. |
