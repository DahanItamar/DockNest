# Competitive landscape

Date: 2026-10-21. Owner: Product Manager.
Star counts and project facts marked "(scan)" come from the coordinator's market scan dated 2026-10-21 and were not re-measured here. No reliable figures exist for the size of the self-hosted Docker backup market (TAM), and none are estimated in this document.

## Category map

| Category | Unit of backup | Examples | What it is good at |
| --- | --- | --- | --- |
| **A. General backup engines** | Files and directories | [restic](https://github.com/restic/restic) (~36.7k stars, scan), [Kopia](https://github.com/kopia/kopia), [Borg](https://www.borgbackup.org/) | Dedup, encryption, many storage backends, mature repository checks |
| **A′. UIs over engines** | Files and directories via the engine | [Backrest](https://github.com/garethgeorge/backrest) (~7.7k stars, scan; web UI over restic), KopiaUI | Scheduling, browsing, restoring files, hooks |
| **B. Docker volume backup** | Named volumes (+ some host paths) | [offen/docker-volume-backup](https://github.com/offen/docker-volume-backup), [VolumeVault](https://github.com/Darkdragon14/VolumeVault) (106 stars, scan; Laravel UI over offen) | Simple setup next to Compose. Stop labelled containers. Many storage backends |
| **C. Site-level Docker DR** | A whole site: images, writable layers, mounts, config, database | **DockNest**; DockerRescueKit (1 star, 11 open issues, scan; claims not verified, repository link not found by this review) | Recovering one site as a unit, with isolated restore |
| **D. Provider snapshots** | Whole VM disk | Hetzner, DigitalOcean, AWS etc. | One click, includes everything on the disk |

DockNest competes in C, gets compared with A′ and B, and sits **alongside** D. The README already recommends using it together with a server snapshot.

## Comparison

Legend: **Yes** = documented or implemented. **Partial** = possible with limits or user scripting. **No** = not offered. **Unknown** = not verified by this review. DockNest cells were checked against the code on `main` (2.13.3, 2026-10-31). Competitor cells cite the linked public docs as of 2026-10-21. Re-check them before publishing any comparison.

| Capability | DockNest 2.13 | restic / Kopia | Backrest | offen/docker-volume-backup | VolumeVault | Provider snapshot |
| --- | --- | --- | --- | --- | --- | --- |
| Restore one site as a unit | Yes | Partial (paths you choose) | Partial | Partial (volumes) | Partial (volumes into new volumes) | No (whole VM) |
| Docker images and writable layers | Yes (`docs/backup-format.md`) | No | No | No | No | Yes (disk-level) |
| Compose / env / run configuration | Yes, explicitly selected files | Partial (if paths included) | Partial | No | No | Yes (disk-level) |
| Database capture after a checked clean shutdown | Yes for qualified PostgreSQL 16 / MySQL 8.4 / MariaDB 11.4 / Redis 7.4 fixtures ([support matrix](../support-matrix.md)) | Partial (user scripts) | Partial (hooks) | Partial (stops labelled containers; no shutdown proof) | Partial (inherits offen) | Depends on provider |
| Restore into an isolated copy (no ports, isolated network) | Yes (`planRestore`, `src/engine.js`) | No (restores files only) | No | No | Restores to new volumes | No |
| Recorded restore evidence, kept separate from integrity | Yes: 4 dimensions ([recovery-verification.md](../recovery-verification.md)) | Repository check only ([restic check](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)) | Repository check | No | Unknown | No |
| **Scheduled** restore tests | **Yes** (daily, weekly or monthly on a test server, `src/restore-tests/`) | No | No | No | Unknown | No |
| Scheduled repository/integrity checks | Partial (restore tests run on a schedule; scrub is on demand, `POST /api/backups/:id/scrub`) | Yes (cron) | Yes, scheduled maintenance ([overview](https://linuxlinks.com/backrest-web-ui-orchestrator-restic-backup)) | No | Unknown | n/a |
| Outbound notifications | **Yes**: Telegram, email, WhatsApp, Discord, Slack, Microsoft Teams, Google Chat, Mattermost, ntfy, Gotify, Pushover, Matrix, webhook (`src/alerts/`) | Partial (scripts) | Yes: Discord, Slack, Gotify, Shoutrrr, Healthchecks ([overview](https://linuxlinks.com/backrest-web-ui-orchestrator-restic-backup)) | Yes ([README](https://github.com/offen/docker-volume-backup)) | Yes ([docs](https://raw.githubusercontent.com/Darkdragon14/VolumeVault/HEAD/docs/index.md)) | Provider-dependent |
| Dedup / incremental | Partial (incremental mount data, beta; no dedup) | Yes | Yes | No | No | Provider-dependent |
| Storage backends | SFTP and S3-compatible with optional Object Lock; up to 3 extra copies per backup (local disk only with an explicit `ALLOW_LOCAL_BACKUP_STORAGE` override) | Many | Many (restic) | S3, WebDAV, SSH, Azure, Dropbox, Google Drive, local ([README](https://github.com/offen/docker-volume-backup)) | S3, R2, WebDAV, SFTP, Azure, Dropbox, Google Drive, local ([docs](https://raw.githubusercontent.com/Darkdragon14/VolumeVault/HEAD/docs/index.md)) | Provider |
| Many remote hosts from one dashboard | Yes, over SSH with pinned host keys | No (per host) | Partial (one instance per host, or a remote repo) | No (per host) | No remote Docker host support at v1.0.0 ([release](https://newreleases.io/project/github/Darkdragon14/VolumeVault/release/v1.0.0); may have changed) | Per provider |
| Manager needs the Docker socket | **No** (`compose.yaml`) | n/a | n/a | Yes, to stop containers | Uses the Docker CLI (socket access assumed; verify) | n/a |
| Maintenance page during capture | Yes | No | No | No | No | No |
| Independent copy the manager cannot delete | Yes on S3 with Object Lock; also `scripts/protected-copy.py` on a separate host | Partial (append-only modes / backend locks) | Partial | No | Unknown | Provider-dependent |
| Multi-user with per-person MFA | Yes (shared password + personal TOTP; admin/operator) | n/a | Basic auth | n/a | Unknown | Provider IAM |
| Maturity / adoption | New: 44 stars (2026-10-31), created 2026-10-19 | Very mature | Mature | Mature | Early | Mature |

## Where DockNest wins

1. **Whole-site restore unit.** Images, writable layers, mounts, config and databases come back together. No volume tool does this, and engines need scripts for it.
2. **Honest restore evidence.** Integrity, consistency, isolated restore and application checks are recorded separately, with an append-only history. Retention never deletes the latest backup whose application checks passed (`src/artifact-journal.js`).
3. **Security model.** The manager has no Docker socket, uses pinned SSH host keys, encrypts with AES-256-GCM using an external master key, requires per-person TOTP and keeps an audit trail.
4. **Isolated restore by default.** It never overwrites production. That is safe to run on a live server and gives agencies something they can demonstrate to clients.
5. **Agency-friendly extras:** a maintenance page for visitors, static nginx sites alongside Docker sites, and many servers in one dashboard.

## Where DockNest loses

1. **Integrity scrubs run on demand only.** Restore tests and alerts run on their own, but a scheduled scrub of every stored package is not offered yet.
2. **Storage efficiency.** Incremental backups cover mount data only and are beta; there is no dedup. restic and Kopia will be much cheaper for frequent backups of large sites. A benchmark is needed so this can be stated with numbers (backlog item PM-19).
3. **Downtime.** Docker captures pause writers. Engines and volume tools can do online file copies (with consistency caveats).
4. **Prerequisites.** Root SSH and Python 3.9+ on each source, and an SFTP or S3-compatible target. Each one loses some trial users.
5. **Trust and maturity.** 44 stars (2026-10-31) and one maintainer. Backup buyers are conservative.
6. **Platform scope.** x86_64 rootful Docker only, no NFS/CIFS mounts, no Kubernetes.

## Threats

| Threat | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| Backrest or Kopia adds Docker-aware templates (stop, dump, start hooks with one-click restore) | Medium | High: copies the "good enough" path for P2 | Compete on the isolated restore and recorded evidence, which hooks do not provide. Ship scheduled drills first |
| VolumeVault adds host paths, remote hosts and restore tests | Medium (active project) | Medium | Same as above. Also whole-image and writable-layer capture and no socket in the manager |
| A provider improves snapshots (app-consistent, per-volume) | Low–medium | Medium | Position as provider-independent and site-portable (restore to another provider) |
| DockerRescueKit or a similar new project matures with the same pitch | Unknown | Medium | Evidence over claims. Publish the support matrix and integration results |
| A DockNest restore claim proves wrong in a real incident | Low (if principles hold) | **Severe**: one public post-mortem undoes the trust | Principle 2 (honest claims). Integration gate before any "validated" wording |
| An upgrade breaks an install | Low–medium during the 2.1–2.3 restructure | **Severe** for a backup tool | Versioned migrations, snapshots, upgrade fixtures and drain (2.1.0) |
| Maintainer bandwidth | High | High | Narrow scope. Say no to backend sprawl. Contributor-friendly backlog |

## Implications for the roadmap

- Close the "proof is on demand" gap before adding storage backends beyond S3 (roadmap 2.4/2.5).
- Do not compete on dedup or engine features. If storage cost becomes the blocking objection, consider a restic or Kopia **storage layer** under DockNest's site-level capture instead of building dedup (open question Q6).
- Keep comparison tables honest and sourced. Re-check competitor rows each release.
