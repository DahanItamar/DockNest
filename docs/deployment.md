# Deployment

## Requirements

Central host: Linux, Docker Engine + Compose plugin, persistent storage for metadata only; backup payloads use a separately connected SFTP storage destination, and Node.js 24 for initial setup (or run setup with a temporary Node container). Remote hosts: Linux, Python 3 standard library, Docker, SSH key authentication, and an account able to run the required Docker/filesystem operations. Docker privileges effectively grant control over the remote host.

No central Docker socket or public Docker API is needed. Verify the SSH fingerprint independently before pinning it. Use an SSH account restricted to the necessary hosts, and limit inbound dashboard access to administrators.

## First start

```sh
npm ci
npm run setup
# Set APP_DOMAIN, APP_ORIGIN=https://your-domain and SECURE_COOKIES=true in .env.
docker compose --profile https up -d --build
```

The API binds to central-host loopback port 3000; production access must pass through HTTPS. The local npm start development flow supports loopback HTTP with development cookies; Compose uses production mode and rejects those settings. Read `data/setup.token` locally to complete first-admin enrollment; do not paste tokens into public tickets or logs. The token file is preserved for Compose secret mounting, while the application prevents another first-admin setup.

Compose shares the `state` volume (SQLite metadata) across API and one worker. Backup storage starts unconfigured; connect a remote destination under Storage. No local backup volume is mounted and jobs do not fall back to local payload storage. Both containers run as the Node user. The image prepares volume ownership for UID 1000. Secret files remain outside those volumes and outside Git. On Linux restrict their containing directory to the administrator and ensure the container UID can read the mounted files; Compose file-backed secrets use host filesystem permissions. Do not make private keys world readable.

## Public HTTPS

Point a real domain to the central host and allow ports 80/443. Set these entries in your generated `.env`:

```dotenv
APP_DOMAIN=backup.example.com
APP_ORIGIN=https://backup.example.com
SECURE_COOKIES=true
```

Then:

```sh
docker compose --profile https up -d --build
```

Caddy obtains and renews certificates and proxies to the API. Its profile is optional when you already have an HTTPS reverse proxy. Keep APP_ORIGIN equal to the browser origin and enable secure cookies for HTTPS. The loopback-only HTTP binding remains useful for diagnostics. Do not use the development cookie settings on a public HTTP endpoint.

## Remote preparation and maintenance

Use a staging filesystem with enough space for a full local copy outside all site data paths. Inventory every writer of shared volumes and bind mounts. Configure and test the database shutdown profile, health check, local recovery watchdog, and independent site reverse proxy before production backup.

The central dashboard proxy is distinct from each site's maintenance proxy. A maintenance page must remain available on the original site domain while the application is stopped. Required maintenance integration must block scheduled backups until verified. Manual activation and deactivation must also verify application health. Automated installation of arbitrary existing proxies is not assumed.

## Updates and monitoring

Run `docker compose logs --tail=100 api worker` and review dashboard jobs/recovery failures. A running API does not imply a running worker or a recoverable backup. Monitor disk space, worker activity, failed jobs, and sites requiring recovery. Use one worker until concurrency and crash-recovery behavior have passed the acceptance checks.

Use `scripts/upgrade.sh` to upgrade. It holds new work, waits for running jobs, saves configuration and secrets, and starts the new release. The new release snapshots the metadata before migrating it. The script also prints or performs the rollback. [Upgrading](upgrading.md) covers the script, the manual steps, rollback with pre-upgrade snapshots, the published image and the stability contract. Do not run old code against a migrated database; it refuses to start and names the snapshot to restore.

## Central-system recovery

Administrators can create and download an encrypted manager recovery kit from **DockNest backup**. It uploads to the connected SFTP destination selected for site backups, retains one latest successful copy and can refresh it on a schedule. Keep the recovery passphrase and storage sign-in details separately so you can retrieve the kit after server loss. See [DockNest self-backup](docknest-self-backup.md) for contents, release requirements and fresh-server import steps.

Keep an encrypted off-host copy of the metadata volume and a separately protected copy of `data/master.key`. The backup payloads remain on their configured remote destinations. Stop both processes before copying SQLite metadata, including WAL files, or use SQLite's supported backup mechanism. Protect the setup token and SSH credentials. Never commit these files.

Restore the metadata volume with UID/GID 1000 ownership, restore the exact master key and storage connection configuration, then start the same application version. Test login, metadata visibility, decryption, and a real restore. Losing the key cannot be repaired by resetting the admin password.

An independently downloaded DBM1 payload can be authenticated and decrypted without the dashboard:

```sh
node scripts/decrypt-backup.js payload.enc /secure/master.key recovered.tar.gz
```

The tool streams into a restricted temporary file and publishes output only after AES-256-GCM authentication succeeds. It refuses to replace existing output. The format is 16-byte header (ASCII DBM1 plus 12-byte IV), ciphertext, and final 16-byte authentication tag; the header is authenticated additional data. The key file holds the base64-encoded 32-byte AES key. Inspect the bundled manifest and restore guide before extraction; never pipe unauthenticated plaintext into a tar extractor.

## DockNest rename compatibility

The application, image, and Compose project are now named DockNest/docknest. Compose preserves legacy metadata and Caddy volume names so upgrades reuse existing state and certificates. The old local backup volume is not mounted or deleted; keep it until any legacy backups have been migrated and verified independently. The encrypted backup format, session cookie, existing remote staging paths, and existing authenticator secrets remain compatible. Newly issued authenticator QR labels use DockNest. Do not rename or delete those storage volumes during a branding update.

New sites default to `/var/lib/docknest` for remote staging. Saved site configuration and legacy maintenance fallback paths are preserved; no remote directories or persistent volumes are moved automatically. The checkout remains at its current workspace path.

## DemoHost deployment and storage layout

For an existing nginx host, publish the API only on a loopback port and proxy the selected hostname to it; preserve unrelated virtual hosts and verify nginx configuration before reload. First administrator setup is a separate page at `/#/setup`; the token stays in the restricted deployment-server data directory.

New remote backups use this hierarchy inside the selected SFTP storage root:

```text
BACKUP/
├── <server-name>--<server-id>/
│   └── <site-name>--<site-id>/
│       └── backup_2026-10-03_12-13-14Z--<backup-id>.tar.gz.enc
└── docknest-recovery/
    └── docknest_<manager-key-id>_2026-10-03_12-13-14Z--<backup-id>.dkit
```

If the configured root already ends in `BACKUP`, it is reused without creating `BACKUP/BACKUP`. Names are sanitized and identifiers prevent collisions, including captures within the same UTC second. Site archives remain encrypted; `.tar.gz.enc` describes the encrypted compressed archive. Recovery kits have their own passphrase and `.dkit` format. Temporary uploads use the same filename plus `.partial` until publication succeeds. Failure cleanup and retention remove individual files, never a shared site folder.

Existing backups and recovery kits keep their recorded paths and remain accessible; there is no automatic relocation. Storage offers a metadata-backed folder tree with site download/pin controls and a separate recovery folder. It displays actual paths, includes earlier layouts, lists only DockNest-managed files, and never reorganizes unrelated files.

### Move existing remote files into the new tree

`node --no-addons scripts/migrate-storage.js plan` reports the number of recorded remote site archives and completed remote recovery kits needing migration. It does not scan unrelated SFTP files. Local archives or local recovery kits block this command and require a separate import.

After the exact release passes the deployment gate, retain the previous image and verified encrypted metadata recovery kit, stop API admission and gracefully stop the worker. Check the queue and set the deployment hold using `scripts/deployment-preflight.js hold` with both services stopped. Run `node --no-addons scripts/migrate-storage.js apply` in a one-off container with the same state, master key and storage credentials. The command acquires the worker's exclusive lock and rejects active jobs, restores, downloads, recovery work and pending publications/deletions. Keep the API stopped throughout migration.

Each original file must match its recorded size and SHA256. A new copy is streamed to an exclusive temporary file, synced and read back before publication; the published copy is synced and verified again before one SQLite transaction updates its path and completed publication journal. IDs, pins, manifests, verification history and restore relationships remain intact. Recovery kits go into `BACKUP/docknest-recovery`. Interrupted copies resume from a durable migration journal; unrelated destination files block the operation.

Original files and their directories are retained for rollback. They consume additional storage outside metadata capacity estimates; check actual SFTP free space before starting. Do not delete them until independent restore verification and the rollback retention period are complete. After a crash, verify the migration process and worker are stopped before handling a stale worker lock. Restart both services, verify startup reconciliation, downloads and an isolated Linux restore, then release the hold. File relocation checks establish byte integrity, not restored application correctness.
