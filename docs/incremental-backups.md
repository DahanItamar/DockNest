# Incremental backups (ADR, Q6)

Status: accepted by the owner on 2026-10-28 (option A). Implemented in 2.12.0 as a beta; not validated until the Linux integration passes on the release commit. Date: 2026-10-28.
Background: [open question Q6](product/open-questions.md), the storage report in [restore-tests.md](restore-tests.md)
(Storage report), and the backup package format in [backup-format.md](backup-format.md).

Today every backup is one complete, self-contained, encrypted package. On the owner's server, the storage report
estimates that incremental backups could save about 71% at best. This document decides how DockNest would make
incremental backups without losing what full packages give us: offline recovery, the recovery kit, ZIP export,
simple retention, and restore tests.

Real incremental backup and restore count as validated only after the Linux integration tests below pass
(see AGENTS.md).

## The choice

| | A. Hybrid chains with GNU tar (recommended) | B. restic or Kopia layer |
|---|---|---|
| How | A full package every few backups. In between, packages that hold only the files that changed, made with GNU tar's built-in `--listed-incremental` mode. | A proven deduplicating engine stores the data in its own repository. DockNest drives it. |
| New software on site servers | None. The helper already runs GNU tar. | A restic or Kopia binary on every site server. This breaks the "Python standard library only" helper rule in AGENTS.md. |
| Expected saving | Most of the estimate for mount data (databases, uploads). Less for images (see Images). | Close to the full estimate, plus dedup across sites. |
| Encryption | Unchanged. Each package is the existing AES-256-GCM format with the same master key. | A second key system (the engine's repository password) to store, rotate and recover. |
| Offline recovery and recovery kit | Still works: restore the full package, then each increment in order. Same tools. | Needs the engine to read anything. The recovery kit has to ship it. |
| Retention | Chains: a full package is kept until every increment that needs it is gone. | The engine's own prune, separate from DockNest's retention and pins. |
| Storage destinations | The existing local, SFTP and S3 adapters, unchanged. | Every destination must also be an engine repository. Storage migration becomes a repository copy. |
| Risk | Medium. A familiar format, but chain bugs can make a restore point unreadable. Tests below. | High. A new dependency on every server, two sources of truth, and a large change to the trust model. |

**Recommendation: A.** It keeps the product's promise ("one package you can restore without DockNest") at the
level of a chain, adds no dependency, and gets most of the saving. B stays the fallback if A's real saving, measured
on the storage report after release, is far below the estimate.

## Decisions at a glance (option A)

| Topic | Decision |
|---|---|
| Default | Off. Opt in per site under backup settings: "Incremental backups (beta)". Existing sites and backups do not change. |
| Chain | One full package, then up to N increments. Default N = 6 (with daily backups, one full per week). Range 1 to 30. |
| What is incremental | Mount archives (`mount-I-J.tar`). Images only when their ID is new to the chain (see Images). Manifest, config files and restore guide are always complete. |
| New full package when | The interval is reached; the chain's full package is missing, unverified or being removed; the source's tar snapshot file is missing or does not match; the container, mount or image set changed; the storage destination changed; the site moved; the manifest format changed; the previous increment renamed folders (GNU tar repeats rename records in later increments, so the chain ends there); the owner asks ("Make a full backup now"). |
| Restore | Restore the full package, then each increment in order, into a fresh directory. Every package in the chain is authenticated before any byte is extracted. |
| Retention | Counts restore points as today. A full package is deleted only when none of its increments are still kept. So up to N extra packages may stay. Pinning an increment pins its whole chain. |
| Integrity | Every increment's encrypted manifest names its parent's backup ID and ciphertext SHA-256. A chain is valid only when every link matches. |
| Restore tests | Test the latest restore point, which for an increment tests the whole chain. |
| ZIP export | Phase 1: full packages only. An increment offers "Download chain" (the encrypted packages plus a short order file). Phase 2 may add ZIP of a chain if users ask. |
| Moves | Use the restore path, so they work with chains. The first backup after a move is always full. |
| Rollback | Turning the option off makes the next backup full. Existing chains stay restorable. |

## How a backup is made

The capture steps do not change: the same stop, copy, commit, restart and health checks, and the same downtime.
Only what goes into the package changes.

1. The worker decides full or increment before the job starts (rules above) and passes it to the helper with the
   parent's backup ID and ciphertext SHA-256.
2. For an increment, the helper archives each mount with
   `tar --listed-incremental=<state>/<site>/<mount>.snar` using the same flags as today (`--xattrs --acls
   --numeric-owner --format=posix`). It works on a copy of the snapshot file, so a failed backup does not advance the
   chain.
3. The snapshot files live on the source server in the helper's state directory (root only, mode 0600). A copy of
   each one also goes inside the encrypted package, so a chain does not depend on the source server's disk to restore.
   If the source copy is missing or its SHA-256 does not match the one recorded in the parent package, the helper
   makes a full package instead and says why in the job log.
4. The helper commits the new snapshot files only after DockNest has stored and verified the package.
5. The manifest gains `"kind": "full" | "incremental"`, `"chain": { "id", "position", "parentBackupId",
   "parentSha256" }`, and per mount whether its archive is level 0 or an increment. Format: backup format v2, which
   older DockNest versions refuse with a plain message instead of misreading.

### Images

Committed snapshot images change on every backup, and `docker save` writes all of an image's layers. So:

- Original images whose ID is already in the chain are not saved again. The manifest refers to the package that holds
  them.
- Committed snapshots are saved in every package, as today. They are usually small (only the container's writable
  layer on top of shared layers), but `docker save` repeats the base layers. Phase 1 accepts this and measures it.
  If it turns out large, phase 2 can store only the top layer.

This is why A will save less than the storage report's estimate. The report will show the real saving once chains
exist ("Saved by incremental backups: X").

## How a restore works

1. Load the chain from the database: the target backup and its ancestors back to the full package.
2. Before extracting anything, check every package: the stored size and SHA-256, the GCM tag, and that each
   manifest's parent ID and parent SHA-256 match the package before it. A broken link stops the restore with
   "This backup depends on backup X, which is missing or damaged. Restore X's chain from an earlier point, or pick a
   full backup."
3. Extract the full package, then each increment in order, with `tar --listed-incremental=/dev/null -x`. This also
   applies deletions, so files removed on the source are removed in the copy. The existing path checks (no absolute
   paths, no `..`, no links that escape) run on every archive, including GNU dump-directory entries.
4. Images: load the images each package lists, in chain order. Then the restore continues exactly as today.

Free space checks use the sum of the chain's package sizes.

## Retention, pins and deletion

- The retention count is restore points, as today.
- Deleting a package that later increments depend on is refused, unless the whole rest of the chain is also being
  deleted. The UI shows "Delete this backup and the N backups that depend on it".
- Retention may keep a full package past the count while its increments are kept. The storage report shows these as
  "kept for a chain".
- Scrub (re-verify) of an increment verifies its whole chain.
- Storage migration copies whole chains, the full package first, and switches a chain only when every package is
  copied and verified.

## Checks when a backup is made (2.12.1)

Before DockNest publishes a package from an incremental site, it checks what the helper says it made against what
DockNest asked for and against the package itself:

- the chain id, the position (no gap, no repeat) and the parent's backup ID and SHA-256;
- the rename marking (`renamesSeen`, sent since 2.12.0): an increment without it comes from a helper that cannot say
  whether the increment holds folder renames, so DockNest cannot know whether the chain must end there;
- every mount archive has the package's level (0 in a full backup, 1 in an increment), an increment covers exactly the
  mounts of its parent, and a mount that holds renames is never in a package that says it has none.

If any check fails, DockNest fails closed: the package is not published, the job fails with a plain message, and the
source keeps its previous snapshot files. The next backup of the site is full (reason `chain-inconsistent`), so a new
chain starts from a package DockNest can trust. The site's "Backup failed" alert says the backup was not saved and the
next one will be full. Failing the job was chosen over keeping the package and only forcing the next backup full: a
package DockNest cannot confirm as part of its chain must never look like a good restore point. The cost is one missed
restore point; the next scheduled backup is a full one. No database change: the forced full backup reuses the existing
per-site flag with a new value, which an older DockNest reads as "full backup requested".

DockNest sends its own helper to the server on every call, so an older helper on a site server should not happen in
normal use; the check also covers a modified or broken helper.

## Scrub and broken chains (2.12.1)

A scrub (re-verify) of an increment authenticates every package of its chain and checks every link (unchanged). A scrub
of a package that later increments build on now also checks the links of every backup built on it (the database rows
and the stored manifests). If a link is broken, the scrub fails, names the backup the broken link depends on, marks the
backups that can no longer be restored as unverified (so the next backup is full) and raises the site's "Backup failed"
alert with its own reason. If the scrubbed package itself fails, every backup built on it is marked unverified too.
DockNest has no scheduled scrub; the scheduled check of a chain is the restore test, which tests the newest restore
point and so its whole chain.

## Recovery without DockNest

Only the recovery kit and a copy of the site's storage folder are needed: no DockNest database, API or "Download chain".
The kit's `decrypt-backup.js` verifies the chain links the same way the server does, and the kit's `helper.py` rebuilds
the files with the same checks as a DockNest restore. Steps (as root on a Linux host with GNU tar, Node 24 and Python 3):

1. Restore the kit into a new folder: `node scripts/recovery-kit.js restore manager.dkit NEW_KIT_FOLDER PASSPHRASE_FILE`.
   It writes `master.key`, `recovery/decrypt-backup.js` and `recovery/helper.py`.
2. Copy the site's backup folder from storage (all its `backup_<time>--<backup ID>.tar.gz.enc` files) to a local folder.
3. Decrypt the chain of the backup you want:
   `node NEW_KIT_FOLDER/recovery/decrypt-backup.js --chain COPY/backup_<time>--<ID>.tar.gz.enc NEW_KIT_FOLDER/master.key DECRYPTED`.
   It starts at that package and follows the parent links of the sealed manifests back to the full backup (each parent
   is found by its backup ID in the file name and must have the SHA-256 the increment recorded). It checks every
   authentication tag and link before it keeps anything, then writes the packages in restore order and `CHAIN.json`.
   A missing, damaged or swapped package stops it with "This backup depends on backup X, which is missing or damaged."
   A chain download folder with `ORDER.txt` works the same way (`--chain FOLDER`).
4. Rebuild the files: `python3 NEW_KIT_FOLDER/recovery/helper.py restore-chain DECRYPTED RESTORED`. For each mount it
   extracts the full backup, then each increment in order with `tar --listed-incremental=/dev/null` (deletions and
   renames are applied), after the same link, artifact, free-space and path checks as a DockNest restore, into
   `RESTORED/data-I-J`. It prints, as JSON, which folder belongs to which container mount, the `images.tar` files to
   `docker load` in order, and the configuration archives. It starts nothing. If any check refuses, it removes what it
   wrote, so `RESTORED` is left as it was (empty, or not there).
5. Continue as for a single backup: load the images in order, then create the containers from the manifest with those
   folders as their mounts, in an isolated network first.

Extracting by hand with plain GNU tar is described in the restore guide inside each package. Run tar from inside the
destination folder rather than with `-C` (GNU tar makes the temporary folder of a folder-name swap relative to the
working directory), and remove a restored symlink before extracting a later archive that has a real folder at that path.

The Linux integration test restores two points this way (the end of the longest chain, and an increment in which two
folders swap names) and compares the file tree and database with the source at that time.

## Upgrade safety

- Additive migration 12 (`compatible: true`): a `backup_chain_links` table (kind, chain id, parent id, position per
  chain package; no row = a self-contained full package) and a `site_incremental` table (default off, interval 6).
  `backups` keeps its columns because older code and tools insert into it positionally.
- Existing backups are full packages and keep working unchanged.
- Downgrade: a version without this feature refuses v2 packages, and its retention does not know about chains. Turn
  incremental off for every site, then make a backup, before downgrading to 2.11. The upgrade notes say so, and the update center
  warns before a downgrade when the database contains incremental backups.
- The feature ships labelled beta and opt-in, like moves and restore tests did.

## What we will not do

- No dedup engine of our own (Q6 option b). GNU tar's incremental mode compares whole files. It does not split files
  into chunks.
- No block-level database increments. A database file that changed is stored whole. Online database dumps (Q2) are a
  separate topic.
- No cross-site dedup.

## Tests before it counts as working

- Unit: chain selection rules, every reason a backup becomes full, retention with chains and pins, deletion refusal,
  link verification (missing, reordered, swapped and tampered packages).
- Helper: an increment holds only changed files; deletions and renames apply on restore; xattrs, ACLs, owners, modes,
  symlinks and hard links survive a full + 3 increments restore; a missing or mismatched snapshot file forces a full
  backup; a failed upload does not advance the snapshot file.
- Linux integration (required): a real site with a database and uploads, 1 full + 6 increments with changes, deletes
  and renames between them; restore from every point and compare file trees and database checks to the source at that
  time; restore test passes on the newest point; storage migration of a chain; downgrade refusal.
- Measured result in the release notes: the real saving on the test fixture next to the storage report's estimate.

## Owner answers (2026-10-28)

1. Option A (hybrid GNU tar chains) is approved.
2. Default interval: one full backup every 7 backups (N = 6).
3. Phase 1: "Download chain" for increments; ZIP export for full backups only.
4. Release: 2.12.0, after storage per site and backup copies (2.11.0), so each destination can hold whole chains.

## Leaving beta

Incremental backups stay beta until all of these are true:

- The Linux integration tests above pass on the release commit and are part of the required checks.
- The owner's server has run chains for at least 4 weeks with no failed restore test on an increment.
- Restoring from a chain without DockNest, using only the recovery kit, has been done once and recorded in
  [acceptance.md](acceptance.md).
