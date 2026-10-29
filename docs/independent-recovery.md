# Durable and independent recovery

Publication journals are written before transfer and record authentication before rename. Worker startup and five-minute reconciliation authenticate pending packages again before adopting them. A partial without durable authentication is never published. Metadata, integrity/consistency evidence and completion are committed together. Offline or corrupt destinations leave a pending review event rather than erase an authenticated package.

Local publication fsyncs file bytes and directory entries before completion; deletion fsyncs its directory before metadata removal. SFTP requires working `fsync@openssh.com` file support and fails publication closed when unavailable. SFTP has no portable directory-fsync operation, so remote rename power-loss durability still depends on the independent storage server. Completed journal existence/size checks invalidate missing or resized packages without inventing repair. Full authentication still requires a scrub; existence/size alone cannot detect same-size corruption. Windows directory durability is not qualified by the POSIX fsync checks.

Retention records deletion intent before removing bytes and removes metadata only afterward. Downloads, queued/running restores, integrity scrubs, pins and the latest successful configured application recovery point block deletion. Pending packages refuse new downloads, restores and pin changes. Missing-file reconciliation finishes an interrupted deletion; inaccessible storage preserves intent for retry. Protected recovery points may exceed ordinary count retention.

## Source boot recovery

Administrators can opt in with authenticated `POST /api/sites/:id/boot-recovery`. This installs the versioned helper and a systemd oneshot after Docker/network startup. It registers a dedicated root-owned 0700 staging directory, and keeps private, fsynced 0600 job journals with original service identities and restart order. It does not start immediately or reboot the server.

On a later boot, recovery examines interrupted jobs from previous boots, rejects changed identities and unexpectedly running services that were originally stopped, restarts originally running databases before writers, and clears maintenance only after source/public health succeeds. A durable completion marker prevents replay on subsequent boots, including after an operator intentionally stops the recovered service. Same-boot jobs remain owned by their watchdog. A failed boot check exits nonzero for systemd monitoring and keeps maintenance/review evidence. Use `systemctl status docknest-source-recovery.service` for sanitized counts. Custom non-systemd hosts need a reviewed boot integration.

The manager uses an expiring SQLite worker lease instead of a lock file. After an unclean death the replacement worker waits until the lease is 60 seconds stale, takes it over and marks interrupted jobs recovery_required; the affected server accepts no new jobs until an operator inspects source recovery and clears them. Takeover shows only that the old worker stopped renewing, not that its source operation was rolled back. Startup journal reconciliation then runs in the single worker. `npm run worker:status` lists the lease and recovery_required jobs.

## Manager and key recovery kit

Run the kit command in the manager release with Node 24. The exporter uses the [SQLite online backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) so WAL state is included consistently. It embeds the 32-byte manager key, metadata/authentication snapshot, and standalone package-decryption/Python recovery tooling in a scrypt-derived AES-256-GCM envelope. The separate recovery passphrase must contain at least 24 characters. Store it separately from the kit; never pass a password as a command argument.

```sh
# Use an existing private 0600 passphrase file, held outside Git.
DOCKNEST_RELEASE=<matching-commit> node scripts/recovery-kit.js export /private/manager.dkit /private/recovery.passphrase
node scripts/recovery-kit.js restore /private/manager.dkit /private/new-manager /private/recovery.passphrase
```

Wrong passphrases/tampered kits fail authentication before creating output. Import requires a new directory; it never overwrites live state. Sessions/challenges and download leases are revoked, schedules paused, queued work cancelled and interrupted work flagged for recovery review. Keep the matching application image/source, production environment settings and any environment-mounted SSH/storage credentials independently: those environment files are not embedded automatically. On Windows, protect private files/directories with user ACLs; POSIX mode bits do not substitute for Windows ACLs.

Validate recovery on a clean host with the original manager unavailable. Reconnect retained storage using independently verified host keys, authenticate a package using the recovered master key, and run an isolated restore/data check before resuming schedules. Kit encryption does not prove that the application or its external dependencies recover.

## Restoring an incremental chain

An incremental backup depends on the packages before it. You need only the recovery kit and a copy of the site's
storage folder (DockNest itself, its database and **Download chain** are not needed). Run these as root on a Linux host
with GNU tar, Node 24 and Python 3; the full steps and what each one checks are in
[incremental-backups.md](incremental-backups.md#recovery-without-docknest).

1. Restore the kit into a new folder (above). It holds `master.key`, `recovery/decrypt-backup.js` and
   `recovery/helper.py`.
2. Copy the site's `backup_<time>--<backup ID>.tar.gz.enc` files from storage into one local folder.
3. Check and decrypt the chain of the backup you want:
   `node recovery/decrypt-backup.js --chain <copy>/backup_<time>--<ID>.tar.gz.enc master.key <new empty folder>`.
   It finds the chain from the sealed manifests and verifies every file's checksum, every authentication tag and every
   parent link before it keeps anything. A chain download (a folder with `ORDER.txt`) works too: pass the folder.
4. Rebuild the files: `python3 recovery/helper.py restore-chain <decrypted folder> <new empty folder>`. Each mount is
   rebuilt from the full backup and then each increment in order (deletions and renames applied), after the same path
   checks DockNest makes. It prints which folder belongs to which container mount and the `images.tar` files to load.
5. Load the images in the order printed, then continue as for a single backup.

Never skip a package or change the order: a missing or swapped increment gives a wrong tree, and a link that does not
match is a reason to stop. Extracting by hand is described in the restore guide inside each package; prefer the kit's
helper, which also handles a symlink later replaced by a folder and two folders that swap names.

Check paths in every archive as for a full backup, including directory-listing entries.

## Independent protected copies

Keep an offline or independently administered archive. The manager must not possess its root/deletion credential. On that separate Linux archive host, create a root-owned 0700 archive under root-owned ancestors without group/other write permission. Fetch a package/kit with a read-only primary-storage credential, then run:

```sh
sudo python3 scripts/protected-copy.py /private/incoming/payload.enc /private/archive EXPECTED_SHA256
```

The expected checksum must come from authenticated publication/kit evidence. The script copies to an exclusive file, verifies SHA256, fsyncs, publishes without overwriting and creates a private index. Files are root-owned/read-only; an ordinary manager identity cannot delete them because it cannot write/traverse the archive. Retention on this host is a separate administrator responsibility. This is separation of deletion authority, not WORM/cloud object-lock or protection from compromise of the archive root administrator. Do not run the archive host with the source server's or manager's administrative credential.

Reconciliation failures and integrity failures generate sanitized audit events and job/worker health evidence. Configure independent systemd/provider monitoring for host loss; the manager cannot alert from a host that is completely unavailable.
