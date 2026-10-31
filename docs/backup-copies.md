# Storage per site and backup copies (ADR)

Status: accepted by the owner on 2026-10-28. Implemented in 2.11.0. Date: 2026-10-28.
Related: [storage-backends.md](storage-backends.md), [incremental-backups.md](incremental-backups.md),
[backup-format.md](backup-format.md).

Today DockNest writes every backup to one destination, the one selected on the Storage page (setting
`backup_storage_target`, read by `activeStorage()`). Each backup row has one `path`. This document adds two optional
things:

- **Storage per site:** a site can use its own main destination instead of the default one.
- **Backup copies:** a site can keep extra copies of each backup on other destinations, for example the main copy on
  an SFTP server and a second copy on Cloudflare R2 (the 3-2-1 rule: 3 copies, 2 kinds of storage, 1 off site).

Real copy and restore count as validated only after the Linux integration tests below pass (see AGENTS.md).

## Owner answers (2026-10-28)

| Question | Answer |
|---|---|
| A copy fails to upload | The backup still counts once the main copy is verified. The failed copy sends an alert, retries automatically, and the site shows "Copy missing" until it works. |
| Retention | Per copy. Each destination keeps its own count (for example 7 on fast SFTP, 30 on cheap R2). |
| Where storage is chosen | One default destination for all sites, as today. Each site may override its main destination and add copies. |

## Decisions at a glance

| Topic | Decision |
|---|---|
| Default | Nothing changes for existing sites. They use the default destination and have no copies. |
| Main destination | Optional per site. Empty means "the default destination". The backup job writes there, exactly as today. |
| Copies | 0 to 3 extra destinations per site, each with its own retention count (default: the site's count). A copy destination must differ from the main one. |
| What is copied | The same encrypted package, byte for byte. No re-encryption, so every copy has the same SHA-256 and the same master key opens it. |
| When | Right after the main copy is published and verified, as its own worker step. Copies never extend the site's downtime. |
| How | Read the ciphertext from the main destination and stream it to the copy destination through the existing publication journal: write `.partial`, sync, authenticate (SHA-256 and GCM tag), rename. A copy is recorded only after authentication. |
| Failure | Retry after 5 minutes, 30 minutes, 2 hours, then every 6 hours, for up to 7 days. Alerts: `backup.copy_failed` (first failure), `backup.copy_recovered`. After 7 days the copy is marked `gave_up`; the next backup tries again. |
| Restore | From the main copy. If it is missing or fails authentication, DockNest offers the copies, newest-verified first. The owner can also pick a copy directly. |
| Retention | Per destination. Pins apply to every copy. Object Lock deferrals are per copy. Deleting a backup deletes all its copies. |
| Incremental chains | Each destination holds whole chains. A copy of an increment is made only after its parent is copied there. |
| Recovery kit | Written to every destination that holds copies, so each one can be recovered on its own. |
| DockNest's own backup | Unchanged: it uses the default destination. |

## Data model

Additive migration, marked `compatible: true`:

- `site_storage(site_id PRIMARY KEY, main_target_id NULL)`: NULL means the default destination.
- `site_storage_copies(site_id, target_id, retention, PRIMARY KEY(site_id, target_id))`.
- `backup_copies(backup_id, target_id, path, status, attempts, next_attempt_at, last_error, verified_at,
  PRIMARY KEY(backup_id, target_id))`, with status `pending | copying | verified | failed | gave_up | deleted`.

`backups.path` stays the main copy, so older code and the recovery kit keep working. An older DockNest version
ignores the new tables: it still backs up and restores from the main copy, and leaves extra copies alone.

## Safety rules

- A destination cannot be removed while it holds copies. The Storage page says how many and offers "Delete these
  copies" or "Move them" (storage migration).
- A copy is never written over: a different checksum at the same path fails the copy.
- Copy steps hold a lease so retention cannot delete a package while it is read.
- The capacity check runs on the copy destination before each copy.
- Logs and alerts name the destination, never its credentials.

## Storage page and site settings

- Site settings, "Storage": "Main destination: Default (Offsite SFTP)" with a change link, and "Extra copies" with Add,
  retention and Remove.
- Backup list: one small destination chip per copy (verified, copying, missing).
- Storage report: bytes per destination include copies; "kept for a chain" and copies are shown separately.

## Tests before it counts as working

- Unit: destination resolution (default, override, removed destination), retry schedule, per-copy retention and
  pins, refuse removing a destination with copies, restore fallback order, chain ordering for increments.
- Integration (S3 job, real MinIO): SFTP main and S3 copy and the reverse; tampered copy is refused; Object Lock
  deferral on the copy only.
- Linux integration (required): back up a real site to SFTP with an S3 copy, delete the main package, restore from
  the copy, and check the restored site.

## Cloudflare R2 and other providers

Separate from this design, S3 leaves beta after the Linux suite runs a full backup and restore against MinIO and
the `s3-integration` job becomes required. The job also runs against real providers (Cloudflare R2 first, then
Backblaze B2) when their credentials exist as GitHub Actions secrets: a dedicated, empty test bucket per provider,
keys limited to that bucket, never printed. Each provider listed as "tested" in the README must pass on the release
commit.

## Release plan

2.11.0: S3 out of beta, storage per site, backup copies. Incremental backups follow in 2.12.0, because they build on
copies (chains on every destination).
