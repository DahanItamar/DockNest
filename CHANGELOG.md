# Changelog

All notable changes to DockNest are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and DockNest uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [docs/upgrading.md](docs/upgrading.md) describes what stays stable within a major version and the deprecation policy. Detailed notes for each release live in [docs/releases](docs/releases).

## [Unreleased]

## [2.1.0] - 2026-10-22

Same code as 2.1.0-rc.1. The release candidate passed the real upgrade validation from 2.0.0 on a Linux Docker runner (install, upgrade as documented, worker drain, downgrade to 2.0.0 and upgrade again with `scripts/upgrade.sh`). See [docs/releases/2026-10-22-v2.1.md](docs/releases/2026-10-22-v2.1.md), including the upgrade notes.

## [2.1.0-rc.1] - 2026-10-22

Release candidate for 2.1.0. See [docs/releases/2026-10-22-v2.1.md](docs/releases/2026-10-22-v2.1.md), including the upgrade notes.

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
