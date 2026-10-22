<div align="center">
  <img src="docs/media/logo-blue.png" alt="DockNest" width="360" />
  <p><strong>Back up Docker sites. Verify recovery points. Restore a private copy.</strong></p>
  <a href="https://github.com/DahanItamar/DockNest/releases/latest"><img src="https://img.shields.io/github/v/release/DahanItamar/DockNest?style=flat-square&label=version&color=5E35B1&sort=semver&display_name=tag" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Node.js-24-339933?style=flat-square" alt="Node.js 24" />
  <img src="https://img.shields.io/badge/deployment-self--hosted-5E35B1?style=flat-square" alt="Self-hosted" />
  <img src="https://img.shields.io/badge/storage-SFTP%20%7C%20S3--compatible-1E88E5?style=flat-square" alt="Encrypted backups on SFTP or S3-compatible storage" />
  <a href="https://github.com/DahanItamar/DockNest/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/DahanItamar/DockNest/ci.yml?branch=main&style=flat-square&label=verify" alt="Verify workflow status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-5E35B1?style=flat-square" alt="License: AGPL-3.0" /></a>
  <p>
    <a href="#at-a-glance">At a glance</a> ·
    <a href="#features">Features</a> ·
    <a href="#requirements">Requirements</a> ·
    <a href="#installation">Installation</a> ·
    <a href="#your-first-backup">First backup</a> ·
    <a href="#documentation">Docs</a>
  </p>
</div>

## At a glance

| | |
| :-- | :-- |
| **Latest release** | Version, date and notes: [latest release](https://github.com/DahanItamar/DockNest/releases/latest) · [Changelog](CHANGELOG.md) |
| **What it does** | Backs up Docker and static nginx sites from your Linux servers to your own encrypted SFTP or S3-compatible storage, and restores any backup to a separate copy to check it. |
| **Status** | Beta. See the [support matrix](docs/support-matrix.md) for what has been tested. |
| **Needs** | A Linux machine with Docker and Docker Compose for the dashboard. Each backed-up server needs Linux, Docker, Python 3 and SSH with a key. Storage is SFTP or S3-compatible (S3-compatible is beta). Details in [Requirements](#requirements). |
| **Install** | **Build from source** with Docker Compose (the default), or use the **published image** `ghcr.io/dahanitamar/docknest` (signed, `linux/amd64`). See [Installation](#installation) and [Upgrading](docs/upgrading.md#use-the-published-image). |

![DockNest dashboard with synthetic sites, activity and storage metrics](docs/media/dashboard.png)

Most backup tools tell you a job finished. DockNest shows you can actually restore from it.

It connects to your Linux servers over SSH, backs up each Docker or nginx site to your own SFTP server or S3-compatible bucket (encrypted), and lets you restore any backup to a separate copy to check it. The live site stays untouched.

> [!NOTE]
> DockNest is still in beta. Check the [support matrix](docs/support-matrix.md) to see what's been tested. Automatic recovery after a server reboot isn't ready for production yet.

## Features

- **Finds your sites.** Connect a server and DockNest discovers its Docker projects and static nginx sites.
- **Backs up the whole site.** Images, volumes, bind mounts, writable layers and the database, captured safely for PostgreSQL, MySQL/MariaDB and Redis.
- **Runs on a schedule.** Each site gets its own schedule and a history of backups. Pin the ones you want to keep.
- **Proves backups work.** Restore any backup to a separate copy and check it. DockNest never overwrites a live site on its own.
- **Keeps visitors informed.** Shows a maintenance page while a site is paused. You design it in a visual editor.
- **Shows what's happening.** Live progress, each step as it runs, and the real reason when something fails.
- **Lets you take your data.** Download any backup as an encrypted file or a ZIP.
- **Stays secure.** Backups are encrypted (AES-256-GCM), server identities are checked before connecting, and every user needs a password plus an authenticator app. The dashboard never touches the Docker socket.

<p align="center">
  <img src="docs/media/job-details.png" width="640" alt="Job details for a synthetic site, with live transfer progress and a plain-language step timeline" />
</p>

## Update Center

- **Opt-in update check.** Nothing contacts GitHub until an administrator agrees once. Then DockNest checks the public release list daily, and you can check on demand. See [outbound requests](docs/security.md#update-checks-outbound-requests).
- **Updates only when you click.** Administrators get an **Update Center** page. An update starts only after an administrator confirms with the password and an authenticator code, never unattended, and never through the Docker socket: a small root service on the host, the host updater, verifies the signed release and runs the upgrade script. While it runs, DockNest shows only an update screen. Downgrades stay a command-line task.
- **Problem reports without personal data.** Failed jobs, storage and server tests, DockNest backups, updates and unexpected app errors offer **Open GitHub**: a review shows exactly what will be shared, then a pre-filled public issue opens in your browser with typed values only (no names, addresses, paths or error text). Settings > About has **Report a bug** for every user. The server sends nothing ([details](docs/security.md#problem-reports)).
- **Safer upgrade script.** `scripts/upgrade.sh` now checks that the target is on `main` and signed, takes a lock so two upgrades cannot overlap, and removes old upgrade files after a successful run. Details in [Upgrading](docs/upgrading.md).

One-time setup for in-app updates, on the DockNest host (Linux with systemd and rootful Docker; not Docker Desktop or rootless Docker):

```sh
sudo scripts/install-updater.sh            # once; also --status, --ack, --repair, --uninstall
```

The updater is optional. Without it, upgrade from the command line with `scripts/upgrade.sh`. The Update Center page shows this setup step and notices when the updater connects. See [Host updater and Update Center](docs/upgrading.md#host-updater-and-update-center).

## How DockNest compares

| | DockNest | Server snapshot | restic / Borg | docker-volume-backup |
| :-- | :-: | :-: | :-: | :-: |
| Restore a single site | ✅ | ❌ | ✅ | ✅ |
| Images and writable layers | ✅ | ✅ | ❌ | ❌ |
| Safe database capture | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Proves the restore works | ✅ | ❌ | ⚠️ | ❌ |
| Maintenance page | ✅ | ❌ | ❌ | ❌ |
| Web dashboard | ✅ | ⚠️ | ❌ | ❌ |
| Storage | SFTP, S3 | Provider | Many | Many |

> [!NOTE]
> What each ⚠️ means:
> - **Snapshot, database:** depends on your hosting provider.
> - **Snapshot, dashboard:** you only get the provider's control panel.
> - **restic / Borg, database:** you need to write your own scripts.
> - **restic / Borg, restore check:** checks the backup files, not a running site.
> - **docker-volume-backup, database:** can stop the containers you label.
>
> **Storage:** restic and docker-volume-backup support S3 and more. Borg uses SSH or a local disk.

DockNest is newer and does less: only Linux servers with Docker, and only SFTP or S3-compatible storage (S3-compatible storage is in beta: it is tested against a simulated S3 endpoint, not yet against real providers). You can use it together with a server snapshot.

## Requirements

| Where | What you need |
| :-- | :-- |
| **DockNest server** (runs the dashboard) | Linux with Docker and Docker Compose. Node.js 24 for the one-time setup. |
| **Each server you back up** | Linux, Docker, Python 3 and SSH with a key. Root access, and free disk space for a temporary copy (or use direct streaming). |
| **Backup storage** | One of these (see [storage backends](docs/storage-backends.md)):<br>• **SFTP:** any SFTP server the DockNest server can reach. It must support `fsync@openssh.com`.<br>• **S3-compatible:** a bucket on AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO or similar, optionally with Object Lock. S3-compatible storage is in beta: it is tested against a simulated S3 endpoint, not yet against real providers.<br>• **Local disk:** for testing only (`ALLOW_LOCAL_BACKUP_STORAGE=true`). |
| **You** | A browser and an authenticator app. |

Just trying it out? Node.js 24 and Python 3 on your own computer are enough.

## Installation

### Production (Docker Compose with HTTPS)

```sh
git clone https://github.com/DahanItamar/DockNest.git
cd DockNest
npm ci
npm run setup
```

Point a domain at the server, open ports 80 and 443, and set these in `.env`:

```dotenv
APP_DOMAIN=backup.example.com
APP_ORIGIN=https://backup.example.com
SECURE_COOKIES=true
```

Start everything (Caddy handles the HTTPS certificate):

```sh
docker compose --profile https up -d --build
```

Already have an HTTPS reverse proxy? Leave out `--profile https`. More in [Deployment](docs/deployment.md).

Prefer a prebuilt image? Releases from 2.1 onward are published as `ghcr.io/dahanitamar/docknest`. See [Use the published image](docs/upgrading.md#use-the-published-image).

### Try it locally

```sh
npm ci
npm run setup
npm run build
npm start
```

In a second terminal, start the worker with `npm run worker`, then open **http://127.0.0.1:3000**. On Windows, use `npm.cmd` if PowerShell blocks `npm`.

> [!IMPORTANT]
> Setup creates `.env`, `data/master.key` and `data/setup.token`. Keep them private and keep a safe copy of `data/master.key`. Without it, your backups can't be decrypted, and resetting the password won't help.

## Your first backup

1. **Sign in** with the setup token from `data/setup.token`, add your authenticator and save the recovery codes.
2. **Connect storage** under **Storage**.
3. **Add a server** and confirm its SSH fingerprint. See [server connection](docs/server-connection.md).
4. **Add a site** and review what DockNest found. See [site setup](docs/site-setup.md).
5. **Run Check readiness.** For Docker sites, set up the maintenance page first.
6. **Run a backup, restore it to a separate copy,** then turn on the schedule.

To set or change the password on Windows, run `scripts\set-admin-password.ps1`. See [Security](docs/security.md).

<details>
<summary><strong>Optional per-site settings</strong></summary>

<br>

Most sites need none of these. Example values:

```json
{
  "deliveryMode": "direct",
  "stagingRoot": "/var/lib/docknest",
  "sqliteIntegrityCheck": "full",
  "sqliteOnlineCheckTimeout": 7200,
  "streamCompressLevel": 1
}
```

| Setting | Default | What it does |
| :-- | :-- | :-- |
| `deliveryMode` | `staged` | `staged` makes a temporary copy on the server, then uploads. `direct` streams straight to storage when disk space is short; the site stays paused until the upload finishes. |
| `stagingRoot` | `/var/lib/docknest` | Where the temporary copy is made on the server. |
| `sqliteIntegrityCheck` | `full` | Checks large SQLite databases before the site pauses. `off` skips the check for databases over 1 GiB; restores always run it. |
| `sqliteOnlineCheckTimeout` | `7200` | Seconds allowed for that check (60 to 21600). |
| `streamCompressLevel` | `1` | Compression for direct streaming (1 to 9). Lower is faster. |

</details>

## Good to know

- **DockNest can back up itself.** Use **DockNest backup** to save its own data, encrypted, to your storage. Keep the passphrase somewhere other than the server. See [self-backup](docs/docknest-self-backup.md).
- **ZIP downloads are not encrypted.** They can include passwords and keys, so keep them private. Database files inside are raw files, not an SQL export.
- **Release notes.** What changed in each version is in [docs/releases](docs/releases) and the [changelog](CHANGELOG.md). Latest: [DockNest 2.1](docs/releases/2026-10-22-v2.1.md).

## Documentation

| Topic | Guides |
| :-- | :-- |
| Setup | [Deployment](docs/deployment.md) · [Server connection](docs/server-connection.md) · [Site setup](docs/site-setup.md) |
| Recovery | [Support matrix](docs/support-matrix.md) · [Database contracts](docs/database-contracts.md) · [Recovery verification](docs/recovery-verification.md) · [Independent recovery](docs/independent-recovery.md) |
| Internals | [Backup format](docs/backup-format.md) · [Storage backends](docs/storage-backends.md) · [Security model](docs/security.md) · [Interface design](docs/design/DESIGN.md) |
| Upgrades | [Upgrading and rollback](docs/upgrading.md) · [Update Center design](docs/update-center.md) · [Host updater threat model](docs/updater-threat-model.md) · [Release validation](docs/release-validation.md) |
| Quality | [Acceptance and limits](docs/acceptance.md) · [Repository privacy](docs/repository-privacy.md) |

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers setup and the checks every pull request runs (`npm run check`, and `npm run test:integration` for backup and restore changes). Questions and ideas go to [Discussions](https://github.com/DahanItamar/DockNest/discussions). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

[GNU AGPL-3.0](LICENSE). Bundled fonts and dependencies keep their own licenses.
