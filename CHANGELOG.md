# Changelog

All notable changes to DockNest are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and DockNest uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [docs/upgrading.md](docs/upgrading.md) describes what stays stable within a major version and the deprecation policy. Detailed notes for each release live in [docs/releases](docs/releases).

## [Unreleased]

## [2.2.2] - 2026-10-22

See [docs/releases/2026-10-22-v2.2.2.md](docs/releases/2026-10-22-v2.2.2.md).

## [2.2.1] - 2026-10-22

See [docs/releases/2026-10-22-v2.2.1.md](docs/releases/2026-10-22-v2.2.1.md).

## [2.2.0] - 2026-10-22

See [docs/releases/2026-10-22-v2.2.0.md](docs/releases/2026-10-22-v2.2.0.md), including the upgrade notes.

Planned as 2.2.0 (the version bump belongs to the release pull request). Draft notes: [docs/releases/2026-10-22-v2.2.0.md](docs/releases/2026-10-22-v2.2.0.md). Not yet validated on a Linux Docker host.

### Added

- Update Center for administrators: an opt-in update check (answered once; with yes, the worker checks the GitHub release list daily and administrators can check on demand; nothing is sent before the answer), upgrade requests confirmed with the password and an authenticator code (`POST /api/updates/requests`), history, and an update lock that answers `423 UPDATE_IN_PROGRESS` to everything but a short list of routes while an update runs. Public `GET /api/updates/progress` returns only phase, target, state and timestamps. Metadata migration 5 (`update-center`, compatible) adds the tables.
- Report a bug (Settings > About): a pre-filled public GitHub issue built in the browser from the version and install mode only; the server sends nothing.
- `TRUST_PROXY` (optional, unset by default): the exact address or CIDR of the reverse proxy whose `X-Forwarded-For` DockNest may trust. Without it no proxy is trusted.
- Optional host updater: `sudo scripts/install-updater.sh` (also `--status`, `--ack`, `--repair`, `--uninstall`) installs a root socket service that verifies a signed release and runs `scripts/upgrade.sh`. It refuses rootless Docker, Docker Desktop and a second install. New `docknest_updater` volume, mounted read-only in the `api` container.
- `scripts/upgrade.sh` flags: `--no-prune`, `--no-verify`, `--capabilities`, and for the host updater `--no-fetch`, `--expect-commit`, `--expect-image-digest`, `--upgrade-only`, `--request-id`. The status file gains `warning`, `reason`, `schemaFrom`, `schemaTo` and `requestId`.
- `docknest-release.json` names the tag, commit, repository and pre-release flag, optional highlights from the release notes front matter, and the updater file hashes; it is signed and the release workflow verifies the signature before publishing.
- `scripts/recovery-kit.js restore --ignore-updater` for disaster recovery.

### Changed

- `scripts/upgrade.sh` requires the target tag to be on `origin/main` and, for 2.2.0 and later, verifies the signed release manifest (needs `curl` and `cosign`; `--no-verify` skips both).
- After a successful upgrade the script keeps the newest 5 upgrade backups, the newest 2 `pre-downgrade-*` and `pre-rollback-*` copies and removes only old images this installation recorded. Runs that failed or were interrupted are kept. Earlier releases never deleted these automatically. `--no-prune` disables it.
- A failed health check after only compatible migrations now restores the previous release automatically (exit 4, no data discarded) instead of exit 5, and the image built for the failed target is removed.
- One `upgrade.sh` run at a time, through `data/.upgrade.lock`.

- No public release candidates. The release workflow refuses any tag with a pre-release suffix (`vX.Y.Z-rc.N`) before it builds anything, so GitHub Releases and image tags show final releases only. A candidate is the release merge commit on `main`: the `Release validation` workflow, run from `main` with that commit as `candidate`, validates it privately (built inside the runner, nothing pushed or tagged). A final `vX.Y.Z` tag is published only when its commit has a successful `Verify` run and a successful candidate validation. The workflow no longer runs on pushed tags; re-validating an existing release such as `v2.1.0` stays available by hand. See the release order in [docs/release-validation.md](docs/release-validation.md#release-order).

### Fixed

- The deployment hold waits for a queued or running DockNest self-backup before an upgrade proceeds.
- A recovery kit taken during a deployment hold no longer restores a manager that refuses all work: export is refused while the hold is on, restore clears it, and restore refuses while the host updater reports a running update.

## [2.1.0] - 2026-10-22

Release notes: [docs/releases/2026-10-22-v2.1.md](docs/releases/2026-10-22-v2.1.md), including the upgrade notes. 2.1.0 has the same application code as the pre-release 2.1.0-rc.1 (listed below; `src/` and `web/` unchanged), which passed the real upgrade validation from 2.0.0 on a Linux Docker runner (install, upgrade as documented, worker drain, downgrade to 2.0.0 and upgrade again with `scripts/upgrade.sh`). The v2.1.0 tag itself also passed Release validation. The entries below were first listed under 2.1.0-rc.1 and apply to 2.1.0.

## [2.1.0-rc.1] - 2026-10-22

Pre-release of 2.1.0, tagged `v2.1.0-rc.1`. The GitHub release for it has been removed (the tag remains); the current release is 2.1.0. Its changes:

### Added

- Versioned metadata migrations tracked in `PRAGMA user_version`. Before migrating, DockNest writes a private snapshot to `DATA_DIR/upgrade-snapshots` and keeps the newest five. Startup is refused on a newer schema, with rollback instructions.
- `scripts/upgrade.sh`: a one-command upgrade, rollback and downgrade with a deployment hold, configuration backup, health wait, automatic return when the schema is unchanged, and JSON progress for unattended runs.
- Public `GET /api/version` endpoint (`{version, schemaVersion}`). The preferences drawer shows the running version and links to the releases page. There is no automatic update check.
- Boot recovery reports `bootRecoveryOutdated` when the helper copied onto a host differs from the running release.
- Signed container images on GitHub Container Registry (`ghcr.io/dahanitamar/docknest`) and a `docknest-release.json` manifest on each release. Release notes are bundled in the image.
- `compose.override.yaml` (ignored by git) for local Compose changes, with an example file.
- Paginated history API.
- Worker lease and graceful drain when the worker is stopped.
- Recovery verification levels.
- S3-compatible backup storage.
- `Release validation` workflow (informational): upgrades a real v2.0.0 Compose installation to a release tag, drains the worker, then downgrades and upgrades again with `scripts/upgrade.sh`, checking data, configuration and secrets. See [docs/release-validation.md](docs/release-validation.md).

### Changed

- Hardened website probe URL validation: resolve once on the source server, refuse metadata, link-local and other internal addresses, pin connections, restrict redirects and apply one total time limit per probe. Sites whose stored URL is refused keep backing up with the probe skipped and a warning.
- Backup status labels describe what was actually checked instead of a single "Verified" label.
- Status marks use the shared icon set instead of text characters.

### Fixed

- A worker killed during a job no longer blocks its replacement after restart.
- Concurrent first start of the API and worker no longer fails with "database is locked".
- Flaky SFTP test fixtures caused by an ssh2 key-generation bug.

## [2.0.0] - 2026-10-17

### Added

- Online integrity checks for large SQLite databases, per-site `sqliteIntegrityCheck`, and reuse of unchanged-database checks.
- Delivery modes per site: a temporary copy then upload, or a direct stream to backup storage.
- Live job progress, step diagnostics and clearer failure causes.

### Changed

- SSH and storage sessions tolerate about 100 seconds of silence.

See [docs/releases/2026-10-17-v2.0.md](docs/releases/2026-10-17-v2.0.md) for the full notes.

[Unreleased]: https://github.com/DahanItamar/DockNest/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/DahanItamar/DockNest/compare/v2.0.0...v2.1.0
[2.1.0-rc.1]: https://github.com/DahanItamar/DockNest/compare/v2.0.0...v2.1.0-rc.1
[2.0.0]: https://github.com/DahanItamar/DockNest/releases/tag/v2.0.0
