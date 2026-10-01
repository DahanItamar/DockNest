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

Before updating, stop API and worker and snapshot the metadata volume and remote backup inventory plus separately stored keys. Build and start the new version with `docker compose up -d --build`. Rollback requires the previous image and compatible saved metadata; do not blindly run old code against a migrated database.

## Central-system recovery

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

See `docs/deployment-DemoHost.md` for the existing nginx deployment on port 3400. First administrator setup is a separate page at `/#/setup`; the token stays in the restricted deployment-server data directory. The login screen contains no Windows setup-script instructions.

New remote backups use `<root>/<server-name>--<server-id>/<site-name>--<site-id>/<UTC-date>/<UTC-time>--<backup-id>/payload.enc`. Names are sanitized and identifiers prevent collisions. Existing backups keep their recorded paths. Storage offers a metadata-backed folder tree with download and pin controls; it lists only DockNest-managed backups and never reorganizes unrelated files.
