# DockNest self-backup

Administrators can open **DockNest backup** in the Administration sidebar, set a separate recovery passphrase (at least 24 characters), and choose **Back up DockNest now**. The existing worker creates the kit and uploads it to the connected SFTP destination selected for site backups. The feature is opt-in and needs no Docker socket. An optional timezone-aware schedule refreshes the remote kit.

One latest successful encrypted kit is retained directly under `<selected-storage-root>/BACKUP/docknest-recovery/`, named `docknest_<manager-key-id>_<UTC-date>_<UTC-time>Z--<backup-id>.dkit`. A root already ending in `BACKUP` is reused. This folder is a sibling of the server folders used for site archives; no extra manager-key directory is created. See the complete [storage hierarchy](deployment.md). A queued job records its destination so a later storage selection does not redirect in-flight work; subsequent jobs use the new selection. Existing site backups retain their recorded paths. An older kit under `docknest-manager/<manager-key-id>/`, or a previous local kit, remains downloadable until a replacement succeeds; cleanup then removes the old file.

A replacement checks SQLite integrity and foreign keys, encrypts the kit locally, uploads to a unique `.partial` file over pinned SSH, flushes remote file bytes, reads back and checks SHA256, renames to the final path, verifies SHA256 again, and records success before pruning the previous copy. A failed upload, changed host key, unsupported fsync, checksum mismatch, failed rename or interrupted worker preserves the previous successful kit. SFTP rename durability depends on the independently managed storage server. Cleanup failures or an active download can temporarily retain another encrypted copy; the worker retries cleanup. Temporary local staging is removed after each attempt and at startup after interruption. Remote manager-kit bytes are included in the destination's tracked storage usage.

You can also use **Download recovery kit** to obtain the saved remote kit through the dashboard. Download endpoints require an authenticated administrator; settings and queue requests also require CSRF and a trusted origin. A separate passphrase encrypts the kit, including its master key; the saved passphrase is sealed with the existing master key for scheduled exports. Status and audit records never return the recovery passphrase or master key. Keep both storage sign-in details and the recovery passphrase outside DockNest, for example in your password manager, so you can retrieve and open a kit after server loss. Without a selected SFTP destination, manual backups are blocked and schedules wait for a connection; there is no local fallback.

The kit contains a consistent SQLite snapshot (connections, storage destinations, schedules, accounts, backup catalog and history), the matching master key and independent recovery helpers. It records the release identifier. It does **not** embed the entire web application, container image, environment files, environment-mounted SSH/storage credentials, or website backup payloads. Keep the matching release image/source, Compose configuration, private environment configuration and any separately mounted credentials available independently. Saved connection credentials in SQLite are included inside the encrypted kit. Website payloads stay in their existing storage destinations.

One copy is a useful minimum for host-loss recovery. It cannot undo a configuration mistake once that state replaces the previous kit. Changing the passphrase affects future kits; the existing kit still needs its old passphrase until a replacement succeeds. Refresh the kit after adding connections or sites, changing credentials, and updating DockNest.

## Fresh-server import

On a compatible fresh Linux Docker server, use your independently saved storage credentials to retrieve the final `.dkit` from the SFTP folder above (ignore `.partial` files). Obtain the matching DockNest release and recovery passphrase. Place the passphrase in a private regular file with mode `0600`; never place it in command arguments, Git, or logs. Import into a new directory:

```sh
node scripts/recovery-kit.js restore /secure/docknest-recovery.dkit /secure/new-manager-data /secure/recovery.passphrase
```

The target directory must not already exist. Import authenticates the kit before writing and validates its SQLite snapshot and master key. It revokes sessions, pauses site schedules and the self-backup schedule, clears local manager-kit history, cancels queued work, and flags interrupted site operations for review. Review the original hosts before clearing any recovery holds.

Install the restored database in the new Compose state volume and use the restored master key as its `master_key` secret (or use the corresponding `DATA_DIR` and `MASTER_KEY_FILE` when deploying outside Compose). Apply UID/GID 1000 ownership for Compose. Restore private deployment configuration and separately mounted credentials. Start the same release, verify login, connections and backup visibility, then perform an isolated website restore before enabling schedules.

## Verification and reference roles

Synthetic tests use an actual loopback SSH2/SFTP server with generated credentials to cover administrator/CSRF controls, secret redaction, opt-in scheduling, destination capture, overlapping work, consistent encrypted exports, durable upload/readback, one-copy replacement, failed writes/fsync/rename, changed host-key rejection, download retention, interrupted work, tamper rejection, local and previous remote layout compatibility, strict server/site paths, shared-folder cleanup, and independent metadata import. The browser check uses a temporary fixture manager and checks setup, worker upload to loopback SFTP, encrypted download, storage-tree recovery visibility, form validation and desktop/dark/mobile layouts:

```sh
npm run check
npm run test:self-backup
```

These checks do not validate a real Linux Docker backup or fresh-server Docker recovery. That integration drill remains required before claiming production recovery validation.

Selected upstream references: [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) for consistent snapshots, least privilege and independent recovery; [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for separating synthetic evidence from real recovery certification. No subagents were spawned.
