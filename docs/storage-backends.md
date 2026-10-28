# Storage backends

DockNest writes encrypted backup packages (`DBM1`, see [backup format](backup-format.md)) and recovery kits to one selected destination. Choosing another destination affects new backups only; existing backups stay where they were published.

| Backend | Status | Requirements |
| :-- | :-- | :-- |
| SFTP | Supported. Real backup and restore validated by the Linux integration suite. | `fsync@openssh.com` file sync, atomic rename, a pinned SHA256 host key and a dedicated directory. |
| S3-compatible | Supported. Real backup and restore validated by the Linux integration suite (MinIO-compatible server); `s3-integration` is a required check. Cloudflare R2 passed one manual run (2026-10-28); other providers are not tested on every release. | Bucket, region and endpoint for AWS S3, Cloudflare R2, Backblaze B2 (S3 API), Wasabi, MinIO or similar. Optional Object Lock. |
| Local directory | Tests and explicitly allowed deployments only (`ALLOW_LOCAL_BACKUP_STORAGE=true`). | A directory on the DockNest server. It is lost with that server. |

Providers: the S3 suite (`npm run test:s3`) has a provider mode for a real, existing bucket (`S3_BUCKET`, plus `S3_PROVIDER` for the report). It passed once, by hand, against **Cloudflare R2** on 2026-10-28: multipart upload, ranged reads, conditional copy publish, the readiness probe and cleanup. R2 is not tested on every release, and its Object Lock support is not tested.

## Adapter boundary

`src/storage.js` re-exports the facade in `src/storage/index.js`. Callers use storage references: a plain path for local storage, or `scheme:<targetId>:/path` for remote storage (`sftp:` or `s3:`). The facade finds the adapter for the reference, loads the destination (and decrypts its credential) and confines the path to the destination root. Every remote adapter (`src/storage/sftp.js`, `src/storage/s3.js`) implements the same operations:

`resolve` · `test` · `readiness` · `makeDirectory` · `statFile` · `openRead` (with byte ranges) · `openWrite` · `syncFile` · `renameFile` · `removeFile` · `removeDirectory` · `capacity`

The publication journal (`src/artifact-journal.js`) relies only on these operations:

1. Write `<file>.partial`.
2. `syncFile` it.
3. Authenticate the package (AES-GCM tag and SHA256) and record that in the journal.
4. `renameFile` it to the final name.
5. Finalize the metadata.

Recovery after a crash re-authenticates whichever file exists before adopting it. A package without an authentication record is never published.

## SFTP

- Writes use exclusive create (`wx`, mode 0600) and are synced with `fsync@openssh.com`. Connecting fails if the server does not support it.
- Publication is an atomic SFTP rename. SFTP cannot sync directories, so whether a rename survives power loss depends on the storage server.
- Host keys are pinned by SHA256 fingerprint. Capacity comes from `statvfs@openssh.com` when the server offers it.

## S3-compatible storage

### Connection

- **Endpoint:** must be HTTPS. Plain HTTP is accepted only on loopback, for example a local MinIO.
- **Addressing:** virtual-hosted (`bucket.endpoint`) by default. Use path-style for MinIO and for bucket names that contain dots.
- **Region:** filled in from the endpoint until you edit it: AWS and Wasabi use the part after `s3.` (bare endpoints mean `us-east-1`), Backblaze B2 uses the part after `s3.` (for example `us-west-004`), and Cloudflare R2 uses `auto`. Other endpoints keep what you type. The region is part of every request signature, so a wrong region fails authentication.
- **Prefix:** an optional folder prefix inside the bucket. Backups go under `<prefix>/BACKUP/<server>/<site>/` and recovery kits under `<prefix>/BACKUP/docknest-recovery/`.
- **Requests:** signed with AWS Signature Version 4, implemented with `node:crypto` and `fetch`, so there is no SDK dependency. Each request body is hashed into `x-amz-content-sha256`, and the provider rejects a body that changes in transit.
- **Credentials:** the access key ID and secret are sealed together with the master key (AES-256-GCM), in the same way as SFTP passwords and keys. They are never returned by the API, written to audit events or included in error messages.
- **Key permissions:** give the key only these permissions, limited to the bucket and prefix: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:AbortMultipartUpload`. With Object Lock, add `s3:PutObjectRetention`, `s3:GetObjectRetention`, `s3:GetBucketObjectLockConfiguration` and `s3:DeleteObjectVersion`.

### Publish semantics

S3 has no fsync or rename. DockNest maps the journal steps like this:

| Journal step | S3 operation | Why it is safe |
| :-- | :-- | :-- |
| Write `.partial` | A streaming multipart upload to the temporary key. Only one part is held in memory: 8 MiB parts, growing by 8 MiB every 1,000 parts (about 440 GB at the 10,000-part limit). Small files use a single `PUT`. A failed stream aborts the upload. | The object does not exist until `PUT` or `CompleteMultipartUpload` succeeds. The S3 API defines both as atomic and durable. DockNest refuses to write over an existing key. |
| `syncFile` | `HEAD` (the object must exist). | Durability is already guaranteed when the upload completes. After completing, DockNest also checks that the object size matches the bytes it sent. |
| Authenticate | Full ranged reads of the temporary object (GCM tag and SHA256). | Ranged reads must return `206` starting at the requested offset. A provider that ignores ranges is refused. |
| `renameFile` | A server-side `CopyObject` (`UploadPartCopy` above 5 GiB), then `HEAD`, then a delete of the exact temporary version. | The copy uses `x-amz-copy-source-if-match` with the ETag of the authenticated object, so a temporary object replaced after authentication is never published. An existing destination is refused. If the destination size differs, publication fails. Object Lock retention is applied here and checked. |
| Crash recovery | Same as SFTP: whichever key exists is re-authenticated in full before adoption. | A completed copy is adopted only after a full re-read and SHA256 match. |

**Limits:**

- If the temporary object cannot be deleted after a successful copy, the publish still succeeds and the `.partial` object remains. Add a bucket lifecycle rule that removes incomplete multipart uploads and `*.partial` objects after a few days.
- A provider that ignores `x-amz-copy-source-if-match` loses the replaced-source protection. Scrubs and crash recovery still authenticate the final object.
- S3 does not report capacity. The dashboard shows the bytes DockNest has stored, with total and available marked as not reported. The 1 GiB free-space check before backups applies only to backends that report capacity.

### Object Lock (immutable copies)

When you turn on immutable copies, backups cannot be deleted or overwritten until the date you choose, even by DockNest or by someone who steals its key. Set a mode and a number of days:

- **Governance:** administrators with a special permission can remove locked backups early.
- **Compliance:** nobody can remove locked backups early, not even the account owner. You pay for storage until the date passes. The form asks you to confirm this before connecting.
- **Days:** each backup is locked this many days after it is created. Retention can only remove a backup after this date. The form warns when the lock is longer than the shortest site retention window (retention count times schedule interval), and again above 365 days.

- **Bucket setup:** the bucket must be created with Object Lock enabled, which also enables versioning. It must have **no default retention rule**. A default rule would also lock temporary uploads and the connection probe, so they could not be deleted. The connection test checks both.
- **When retention is applied:** only when a package is published. The copy request sets `x-amz-object-lock-mode` and `x-amz-object-lock-retain-until-date` to the publish time plus the configured days. DockNest then reads the published object's headers to confirm the lock. If they are missing, publication fails.
- **Deletion:** before deleting, DockNest reads the object's retention and legal hold, and refuses with `EOBJECTLOCKED` while either applies. Retention then records a deferral in `retention_deferrals` (`backup_id`, `retry_after`, `retain_until`, `first_seen`) instead of a blocking retention operation, so the backup stays fully usable: restore, download, integrity checks and pinning keep working. `retry_after` is the lock's retain-until date, or 24 hours later when the provider gives no date (legal hold). One `retention.deferred` audit event is written when the deferral is created, and another only if the date changes. Retention and reconciliation skip the backup until `retry_after`, then try again. Pinning removes the deferral, and a pinned backup is never deleted when the lock ends. A locked backup can therefore outlive the site's retention count.
- **Storage migration:** deferred backups are copied like any other backup and their deferral is cleared. The old locked object stays on the old storage until its lock ends; DockNest does not remove it. The migration result reports `lockedOriginals`.
- **Self-backup:** recovery kits published to the destination get the same retention.
- **Governance mode:** DockNest never sends a bypass header. Only a privileged identity outside DockNest can remove governance retention early.

Object Lock protects published objects from deletion by DockNest or by anyone holding its key. It does not replace an independently administered copy (see [independent recovery](independent-recovery.md)). The bucket owner account can still close the account or change bucket policy.

### Provider notes

These notes are not verified against each live provider. Confirm them with the connection test and an isolated restore.

| Provider | Endpoint example | Notes |
| :-- | :-- | :-- |
| AWS S3 | `https://s3.eu-central-1.amazonaws.com` | Region: filled from the endpoint. It must match the bucket. |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | Region: filled from the endpoint (`auto`). Check Object Lock support for your account before turning it on. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | Region: filled from the endpoint (for example `us-west-004`). Use an application key limited to the bucket. Object Lock must be enabled on the bucket. |
| Wasabi | `https://s3.<region>.wasabisys.com` | Region: filled from the endpoint. Object Lock must be chosen when the bucket is created. |
| MinIO | `https://minio.example.internal:9000` | Use path-style addressing. Plain HTTP works only on loopback. |

## Storage per site and backup copies

Design: [backup-copies.md](backup-copies.md). How 2.11.0 implements it:

- A site's main destination is `site_storage.main_target_id`; no row or NULL is the default destination
  (`backup_storage_target`), exactly as before. A chosen destination that was removed fails the backup closed; DockNest
  never writes to a destination the owner did not pick.
- Copies are queued (`backup_copies`, status `pending`) in the same transaction that publishes the main copy. The worker
  runs one due copy step when no site job waits, oldest backup first. The step checks free space on the copy
  destination, streams the encrypted package as it is to `<path>.partial`, syncs it, authenticates it in full (GCM tag
  and SHA-256 equal to the main copy's), renames it and only then records it. A file already at the copy path is adopted
  only when it authenticates; a different file is never overwritten. A worker restart resumes from the row (not under
  the deployment hold; the 5-minute maintenance step resumes it afterwards).
- Status `copying` is the step's lease: nothing of that backup is deleted while it is read. Every 64 MiB a copy checks
  for a queued site job and, if there is one, steps aside (its `.partial` is removed, it is due again at once and no
  attempt is counted), so a long copy does not hold up a scheduled backup. Retries: 5 min, 30 min, 2 h, then every 6 h;
  after 7 days the copy is `gave_up`. Stored errors are fixed sentences, never storage output.
- Retention: the site's count applies to main packages, each copy destination keeps its own count; a destination the
  site no longer copies to keeps the site's count, and copies not made yet to it are cancelled. When a main package
  ages out, the main file is removed first (Object Lock on it defers everything), then the copies no destination keeps.
  If a copy is still kept, `backup_main_removed` records that and `backups.path` keeps naming the main package;
  `packagePath()` (src/artifact-journal.js) gives download, ZIP export, scrub, restore, restore tests and startup checks
  the newest verified copy instead. Pins apply to every copy; an Object-Locked copy is deferred on its own.
- Downgrade to 2.10 with such a backup: 2.10 sees its main package missing (startup marks it unverified) and its
  retention may remove the row; it never touches copy files. 2.11 cleans up those orphaned copies when it starts again.
- Restore uses the main copy, then verified copies newest first; the owner may choose a copy (`sourceTargetId`).
- A destination cannot be removed while it holds copies, main packages or recovery kits, is the default, or a site uses
  it. Its copies are deleted first (`POST /api/storage-targets/:id/copies/delete`). Deleting copies of backups that exist
  only there needs `includeLastPackages: true`; pinned ones need `includePinned: true`.
- Every other destination that holds packages (copies, or a site's main destination) also receives the newest recovery
  kit. A kit there is removed only after a newer one was written to that same destination.
- Real copies and restores count as validated only after the Linux integration suite passes.

### Using copies

- **Set up.** In the site's storage settings keep "Default" or pick another main destination, then add up to three copy
  destinations, each with its own retention (empty means the site's count). A copy destination cannot be the main one,
  the same bucket or folder twice, or a folder inside another destination. API: `GET` and `PUT /api/sites/:id/storage`
  (administrator, recent sign-in). Nothing is copied retroactively; existing backups stay where they are.
- **While it runs.** The backup is complete when the main copy is verified; copies follow in the background and never
  extend the site's downtime. Each backup shows one chip per copy (verified, copying, missing). A site shows
  "Copy missing" until every configured copy is verified.
- **Failures.** A failed copy is retried automatically (5 minutes, 30 minutes, 2 hours, then every 6 hours, for up to
  7 days), then marked "gave up". The next backup tries again, and **Retry** (`POST /api/backups/:id/copies/:targetId/retry`)
  starts a fresh window. Alerts: `backup.copy_failed` on the first failure, `backup.copy_recovered` and
  `backup.copy_gave_up`; they name the destination, never credentials.
- **Retention.** Each destination keeps its own number of backups; a pin keeps a backup on every destination. If a
  destination uses Object Lock, only its copy waits for the lock to end.
- **Restore from a copy.** Restore uses the main copy. If it is missing or fails authentication, DockNest uses the first
  verified copy that authenticates (newest first) and says which destination it used in the job and the audit log. You
  can also choose a copy directly. A copy that fails authentication is never restored from.
- **Removing a destination.** A destination that still holds copies, main packages or recovery kits, is the default, or
  is used by a site cannot be removed. The Storage page shows how many copies and offers "Delete these copies". If some
  backups exist only on that destination, deleting asks for an extra confirmation (request flag `includeLastPackages`) because it deletes
  those backups.

## Verification status

- **Unit tests:** `tests/s3-storage.test.js` runs against `tests/s3-fixture.js`, an in-process fake S3 endpoint on loopback. The fake checks SigV4 signatures and payload hashes independently. The tests cover multipart streaming and abort, ranged reads, part copies, journal publication and reconciliation, the connect and test API without credential disclosure, and Object Lock application, deletion refusal and expiry.
- **S3 integration job (CI, informational):** `npm run test:s3` (`scripts/s3-integration.js`) runs in the `s3-integration` workflow job against a MinIO-compatible server with throwaway credentials. Upstream MinIO images and binaries are archived, so the job pins the maintained Pigsty fork (`pgsty/minio`) by digest. It covers bucket creation with Object Lock, a 40 MiB streamed multipart upload, ranged reads, conditional copy publication (existing destination and stale ETag refused), the readiness probe with and without Object Lock, retention applied on publish, refused deletes, and removal after a short lock expires. It is not a required check and does not cover virtual-hosted addressing.
- **Not yet verified:** a real provider, real backup and restore through S3, and the Linux Docker integration suite (`npm run test:integration`), which still uses SFTP. Real S3 backup and restore is unvalidated until that suite runs against an S3 destination.
