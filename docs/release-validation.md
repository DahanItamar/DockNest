# Release validation

The `Release validation` workflow replaces the manual upgrade test. For a release tag it builds and runs a real DockNest 2.0.0 installation on a GitHub-hosted Linux runner, upgrades it the way the release notes tell 2.0.0 users to, and checks that nothing was lost. It is informational: it is not a required check and does not block a release.

It runs on every pushed `vX.Y.Z` tag and on demand (Actions, Release validation, Run workflow). The `target` input takes a tag such as `v2.1.0`; empty means the newest final tag. Locally, `node scripts/release-validation.js --target v2.1.0 --allow-local` runs the same driver on a disposable Linux host with Docker. It removes the `docker-backup-manager_state` volume and all `docknest` containers, and refuses to start if either already exists.

## What it does

1. **Install 2.0.0.** Clones the repository at `v2.0.0` into a temporary directory, runs `npm ci` and `npm run setup`, writes a `.env` and starts the repository's own `compose.yaml` with `docker compose up -d --build`: read-only containers, all capabilities dropped, the real named volume.
2. **Create state through 2.0.0.** Completes first-admin setup over the HTTP API (setup token, password, TOTP enrolment; codes are computed from the returned secret). It then writes representative rows through 2.0.0's own `db.js` inside the api container: a server with a sealed credential, a site, an enabled policy, a finished job, a pinned legacy backup (`verified=1` and no `backup_verifications` rows), a restore, audit events and a settings marker. It records a SHA-256 digest of every row of every table, excluding `sessions`, `rate_limits` and the login and enrolment challenge tables.
3. **Upgrade as documented.** `git fetch --tags && git checkout <target> && docker compose up -d --build`. Asserts:
   - `/api/version` reports the target version and `schemaVersion`, and the container runs that version.
   - A `state-v0-to-v<N>-*.sqlite` snapshot exists in the volume and is a healthy 2.0.0 database with the seeded rows.
   - Every pre-existing row is unchanged. New rows are allowed, and the columns compared are the ones 2.0.0 had.
   - The session opened on 2.0.0 still works, and the admin logs in again with password and TOTP.
   - `GET /api/state` lists the seeded server, site, policy, job, backup, restore and audit events, does not expose the server credential, and shows the legacy backup's integrity as `passed` (`source: legacy`). Anonymous requests get 401.
   - The worker runs, `node src/worker-status.js` shows a held lease and a running heartbeat, and no job or restore needs recovery review.
   - `.env`, `data/master.key` and `data/setup.token` are byte-identical to before.
4. **Worker drain.** `docker compose stop worker` must log the draining message and `Worker drained; lease released.`, exit with code 0 (not SIGKILL) inside the container's stop grace period, and leave the lease free. The worker is then started again.
5. **Downgrade and upgrade with `scripts/upgrade.sh`.** `scripts/upgrade.sh --version v2.0.0 --non-interactive --status-file …`, then the same checks on 2.0.0. Then the target's `upgrade.sh`, copied from outside the checkout as [the upgrade guide](upgrading.md#upgrade-with-one-command) instructs for 2.0.0 installs, upgrades back to the target with the same checks. Each status file must end `ok: true` at phase `done` and contain no secret. If the target contains a migration that is not marked compatible, the downgrade runs with `--allow-data-rollback`, which restores the pre-upgrade snapshot. That snapshot holds exactly the seeded data, so the same comparison applies.
6. **Clean up.** Containers, volumes, the local image and the temporary checkout are removed even after a failure.

## Evidence

The job summary shows one PASS, FAIL or SKIP line per phase. The artifact `release-validation-<tag>` holds `summary.md`, `evidence.json` (versions, per-check results, per-table row counts and digests, drain time, status files) and one redacted log per phase with container logs. The run uses throwaway credentials, and the driver replaces every credential it generated or read (master key, setup token, password, TOTP secret, recovery codes, session and CSRF tokens) with `[redacted]`. It then scans the finished evidence and blanks any file that still contains one, failing the job. Secret files are compared by content hash inside the run and their hashes are not recorded.

## What it proves

- An installation made by 2.0.0 keeps its administrator, factors, sessions, servers, sites, policies, backups, restores and audit trail across the documented upgrade, a compatible downgrade and a second upgrade, on the real images and the real volume.
- The pre-upgrade snapshot is written and usable, the migration does not change existing rows, and legacy-verified backups still read as having passed integrity.
- `scripts/upgrade.sh` completes both directions non-interactively, releases its hold and writes an honest status file.
- The worker drains on SIGTERM within its grace period.

## What it does not prove

- **No real capture or restore.** The data is seeded rows, not a backup taken from a remote host over SSH. The seeded server has a placeholder host and key and is never contacted, and the backup file does not exist on storage. Capture, restore and storage behaviour are covered by `npm run test:integration` and `npm run test:s3`. Seeding was chosen because a real capture needs the Docker-in-Docker SSH and SFTP fixtures, which would add a large share of the 40 minute budget and a second source of failures.
- **Source builds only.** [Image mode](upgrading.md#use-the-published-image) (`DOCKNEST_IMAGE`, the signed ghcr.io image, `up --pull never` rollback) is not exercised, and neither is cosign verification.
- **Single host, loopback HTTP.** There is one manager and no remote host, no multi-host fleet, no Caddy `https` profile and no public domain. The instance uses `APP_ORIGIN=https://test.invalid` with `SECURE_COOKIES=true`, because Compose runs in production mode, which refuses an `http` origin. The client sends that `Origin` and the session cookie itself over loopback HTTP.
- **Only 2.0.0 as the starting point,** one administrator, no operators or invitations, no storage target, no boot recovery install, no running job at upgrade time and no forced failure or automatic rollback paths of `upgrade.sh` (exit codes 3 to 6). Those are covered by `tests/upgrade-script.test.js` against a Compose test double.
- **The dashboard and browsers.** Only the HTTP API is exercised.
- **Other architectures and Docker versions.** One `ubuntu-latest` x86_64 runner with its preinstalled Docker.
- **API shape.** The checks read `/api/state` fields as 2.0.0 and later 2.x releases define them. A deliberate change to those fields needs a matching change to `scripts/release-validation.js`.

## Reading a failure

Open the failing phase's log in the artifact. `FAIL` lines in the job log name the check. `Resolve release` fails early when the tag is missing, is not newer than 2.0.0, or its `minUpgradeFrom` excludes 2.0.0. If an upgrade phase fails after the schema migrated, the log shows the same rollback hints that `scripts/upgrade.sh` prints; nothing from a run is ever reused, because the runner is discarded.

## Release order

1. Merge the release PR (version bump, CHANGELOG, notes) after its required checks pass.
2. Wait for the `Verify` run on `main` for that merge commit to succeed. `release.yml` refuses to publish a tag whose commit has no successful `Verify` run.
3. Tag the merge commit: first `vX.Y.Z-rc.N` (pre-release, exact image tag only).
4. Let this workflow validate the candidate. If it passes, merge a version-only PR for `X.Y.Z`, wait for `main` again, and tag `vX.Y.Z`, which gets the `X.Y`, `X` and `latest` image tags.
