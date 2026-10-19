<div align="center">
  <img src="docs/media/logo-blue.png" alt="DockNest" width="360" />
  <p><strong>Back up Docker sites. Verify recovery points. Restore a private copy.</strong></p>
  <img src="https://img.shields.io/badge/version-2.0-5E35B1?style=flat-square" alt="Version 2.0" />
  <img src="https://img.shields.io/badge/Node.js-24-339933?style=flat-square" alt="Node.js 24" />
  <img src="https://img.shields.io/badge/deployment-self--hosted-5E35B1?style=flat-square" alt="Self-hosted" />
  <img src="https://img.shields.io/badge/storage-encrypted%20SFTP-1E88E5?style=flat-square" alt="Encrypted backups on SFTP" />
  <a href="https://github.com/DahanItamar/DockNest/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/DahanItamar/DockNest/ci.yml?branch=main&style=flat-square&label=verify" alt="Verify workflow status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-5E35B1?style=flat-square" alt="License: AGPL-3.0" /></a>
  <p>
    <a href="#features">Features</a> ·
    <a href="#requirements">Requirements</a> ·
    <a href="#installation">Installation</a> ·
    <a href="#your-first-backup">First backup</a> ·
    <a href="#documentation">Docs</a>
  </p>
</div>

![DockNest dashboard with synthetic sites, activity and storage metrics](docs/media/dashboard.png)

Most backup tools tell you a job finished. DockNest shows you can actually restore from it.

It connects to your Linux servers over SSH, backs up each Docker or static nginx site to your own encrypted SFTP storage, and restores any backup into an isolated copy so you can check it, without touching the live site.

> [!NOTE]
> DockNest is in controlled beta. See the [support matrix](docs/support-matrix.md) for tested versions and known limits. Optional boot automation still needs a real reboot test before production use.

## Features

- **Finds your sites.** Connect a server and DockNest discovers its Docker projects and static nginx sites.
- **Backs up the whole site.** Images, volumes, bind mounts, writable layers and the database, captured safely for PostgreSQL, MySQL/MariaDB and Redis.
- **Runs on a schedule.** Per-site schedules, a history of recovery points, and pins for the ones you want to keep.
- **Proves backups work.** Restore any recovery point into an isolated copy and check it. DockNest never replaces a live site automatically.
- **Keeps visitors informed.** Shows a maintenance page while a site is paused, with a visual editor for the page.
- **Shows what's happening.** Live progress, a plain-language step timeline, and the real cause when something fails.
- **Lets you take your data.** Download any backup as an encrypted file or a ZIP.
- **Stays secure.** Encrypted backups (AES-256-GCM), pinned SSH host keys, a password plus an authenticator for every user, and a dashboard that never mounts the Docker socket.

<p align="center">
  <img src="docs/media/job-details.png" width="640" alt="Job details for a synthetic site, with live transfer progress and a plain-language step timeline" />
  <br>
  <sub>All screenshots use mock data.</sub>
</p>

## How DockNest compares

| | DockNest | Server snapshot | restic / Borg | docker-volume-backup |
| :-- | :-: | :-: | :-: | :-: |
| Restore a single site | ✅ | ❌ | ✅ | ✅ |
| Images and writable layers | ✅ | ✅ | ❌ | ❌ |
| Safe database capture | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Proves the restore works | ✅ | ❌ | ⚠️ | ❌ |
| Maintenance page | ✅ | ❌ | ❌ | ❌ |
| Web dashboard | ✅ | ⚠️ | ❌ | ❌ |
| Storage | SFTP | Provider | Many | Many |

<sub>⚠️ means partly or depending on setup: snapshots of a running database depend on the provider; restic/Borg rely on your own scripts for databases and check repository integrity, not a restored site; docker-volume-backup can stop labeled containers; a snapshot has the provider's console, not a backup dashboard. Borg stores over SSH or locally; restic and docker-volume-backup support S3 and more.</sub>

DockNest is newer and focused: Linux servers with Docker, and SFTP storage. It works well alongside a server snapshot.

## Requirements

| Where | What you need |
| :-- | :-- |
| **DockNest server** (runs the dashboard) | Linux with Docker and Docker Compose. Node.js 24 for the one-time setup. |
| **Each server you back up** | Linux, Docker, Python 3 and SSH with a key. Root access, and free disk space for a temporary copy (or use direct streaming). |
| **Backup storage** | Any SFTP server the DockNest server can reach. |
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
5. **Check readiness**, including the maintenance page for Docker sites.
6. **Run a backup and an isolated restore**, then turn on the schedule.

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

- **Back up DockNest itself.** **DockNest backup** saves an encrypted recovery kit of its own data to your storage. Keep the passphrase somewhere else. See [self-backup](docs/docknest-self-backup.md).
- **ZIP downloads are not encrypted.** They can contain secrets, so keep them private. Database files in a ZIP need a matching database image; they are not SQL dumps.
- **New in 2.0:** reliable large SQLite backups, direct streaming, live job progress and more. See the [release notes](docs/releases/2026-10-17-v2.0.md).

## Documentation

| Topic | Guides |
| :-- | :-- |
| Setup | [Deployment](docs/deployment.md) · [Server connection](docs/server-connection.md) · [Site setup](docs/site-setup.md) |
| Recovery | [Support matrix](docs/support-matrix.md) · [Database contracts](docs/database-contracts.md) · [Recovery verification](docs/recovery-verification.md) · [Independent recovery](docs/independent-recovery.md) |
| Internals | [Backup format](docs/backup-format.md) · [Security model](docs/security.md) · [Interface design](docs/design/DESIGN.md) |
| Quality | [Acceptance and limits](docs/acceptance.md) · [Repository privacy](docs/repository-privacy.md) |

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers setup and the checks every pull request runs (`npm run check`, and `npm run test:integration` for backup and restore changes). Questions and ideas go to [Discussions](https://github.com/DahanItamar/DockNest/discussions). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

[GNU AGPL-3.0](LICENSE). Bundled fonts and dependencies keep their own licenses.
