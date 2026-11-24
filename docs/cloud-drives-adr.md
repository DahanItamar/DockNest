# ADR: cloud drives and local folders as storage (rclone)

Status: proposed for 3.0.0. Related: [storage-backends.md](storage-backends.md), [backup-copies.md](backup-copies.md),
[backup-format.md](backup-format.md).

## Problem

Many self-hosters already pay for Google Drive, OneDrive or Dropbox space, or have a USB disk or NAS share next to the
server, but DockNest only writes to SFTP and S3. They either skip offsite copies or run their own sync scripts that
DockNest cannot see, verify or prune.

## Users

- Home and small-office self-hosters with 100 GB to 2 TB of spare cloud drive space.
- Owners who want a second copy on a USB disk or a NAS share mounted into the DockNest container.
- Nextcloud or other WebDAV users.

## Audit

- Storage facade `src/storage/index.js`: adapters `{ sftp, s3 }`, references `scheme:<targetId>:/path`. Operations:
  `resolve test readiness makeDirectory statFile openRead (ranges) openWrite syncFile renameFile removeFile
  removeDirectory capacity`. Publishing relies on write `.partial`, sync, authenticate, rename.
- `targetMode(row)` is `s3` when `auth_type = 's3-access-key'`, else **sftp**. A 2.16.x release reading a row of a new
  kind treats it as SFTP (see Upgrade safety).
- S3 settings live in `storage_target_settings` (kind + JSON), the secret in `storage_targets.credential` sealed with
  the master key. Write mode (append-only) is SFTP only.
- `local.js` exists but is only allowed with `ALLOW_LOCAL_BACKUP_STORAGE=true` (tests).
- Provider picker: `web/storage-providers.js` (groups of presets that prefill the SFTP or S3 form).
- Encryption: every package is AES-256-GCM before it reaches any adapter; adapters only move bytes.

## Decisions

1. **rclone as transport only.** A new adapter `src/storage/rclone.js` (scheme `rclone:`) runs the bundled `rclone`
   binary as a child process per operation: `rcat` for writes (stdin stream), `cat --offset --count` for ranged reads,
   `moveto` for rename, `lsjson --stat` for stat, `deletefile`, `rmdir`, `mkdir`, `about` for capacity. DockNest's
   encryption, journal and authentication stay exactly as they are; rclone never sees plain data and its own `crypt`
   backend is not used. No `rclone rcd` daemon and no mount: nothing runs between operations.
2. **Backends in 3.0.0:** Google Drive, OneDrive (personal and business), Dropbox, WebDAV (Nextcloud, ownCloud, other),
   SMB share. Each is a preset in the Connect storage picker under a new group **Cloud drives** (Drive, OneDrive,
   Dropbox) and **Network and local** (WebDAV, SMB, local folder). Other rclone backends are not offered: every backend
   needs its own test evidence.
3. **Local folder, USB disk, NAS folder** uses the existing `local.js` adapter, not rclone, promoted to supported with
   guards: the folder must be inside a path listed in the new environment setting `DOCKNEST_LOCAL_STORAGE` (for example
   `/backups/usb`), which the owner bind-mounts in `compose.yaml`; never inside `/data`; must be on a different device
   than `/data` (`st_dev` check) or the form warns "This folder is on the same disk as DockNest". The UI explains the
   mount step with a copyable compose snippet. Without the setting the option shows "Needs a folder mounted into
   DockNest" and a docs link.
4. **Bundled binary.** The Docker image downloads one pinned rclone release zip for `linux/amd64` in the build stage,
   verifies its SHA-256 against a value committed in `Dockerfile` (taken from the release's signed `SHA256SUMS`, checked
   with rclone's published PGP key when the pin is bumped), and copies only the binary to `/usr/local/bin/rclone`.
   `rclone version --check` and self-update are never run. Bumping the pin is a normal PR with release notes. Source
   installs (no image) need rclone on `PATH`; the readiness check names the version found and refuses below the pinned
   major.minor. Rejected: a Go library or a JavaScript reimplementation of each API (large surface, no shared test
   evidence); asking owners to install rclone on the host (breaks the one-container install).
5. **Config never on disk in plain text.** For each operation DockNest writes a temporary `rclone.conf` with mode 0600
   into a private per-process folder under `/data/tmp/rclone-<random>/`, passes `--config` to it, runs rclone, then
   reads the file back: if rclone refreshed the OAuth token, the new token is sealed and saved, and the file is deleted
   in a `finally`. Operations on one destination are serialized by an in-process lock so two refreshes never race.
   Environment: `RCLONE_CONFIG_PASS` unset, `--ask-password=false`, no `RCLONE_*` inherited from the container.
   Arguments never contain secrets; paths are confined to the destination root before rclone sees them.
6. **OAuth on a headless dashboard.** The dashboard is usually reached over a domain or a LAN address, so a redirect to
   `127.0.0.1` cannot work. Three ways, in order shown:
   - **A. Paste the address (default).** DockNest starts `rclone authorize <backend> --auth-no-open-browser` inside the
     container, shows the sign-in link, and the owner signs in in their own browser. The provider then redirects to
     `http://127.0.0.1:53682/...`, which fails to load on the owner's computer. The owner copies that address from the
     address bar and pastes it into DockNest. DockNest checks it (host `127.0.0.1`, port `53682`, `state` equals the one
     rclone issued, only `code` and `state` params), forwards it to rclone's local listener inside the container, and
     rclone finishes the exchange and prints the token. The listener lives at most 10 minutes and is killed after.
   - **B. Token from rclone on your computer.** For owners who already use rclone: run `rclone authorize "drive"` on any
     computer and paste the JSON it prints. Parsed strictly (only `access_token`, `token_type`, `refresh_token`,
     `expiry`), never logged.
   - **C. Your own app ID (advanced).** Optional client ID and secret for Drive, OneDrive and Dropbox, used with A or B.
     Recommended for Google Drive: rclone's shared Google app is rate limited. The help says that a Google app left in
     "Testing" mode stops working after 7 days.
   Scopes: Drive `drive.file` (DockNest sees only files it created), Dropbox app-folder access when C is used, OneDrive
   `Files.ReadWrite` + `offline_access`. After the token, OneDrive's drive is picked with a short list
   (`rclone backend drives`, non-interactive `config create --non-interactive`).
7. **Token storage.** Token JSON, client secret, WebDAV and SMB passwords are sealed with the master key in
   `storage_targets.credential`, exactly like SFTP keys and S3 secrets. The API never returns them; it returns
   `connected`, `account` (the email or user name the provider reports, masked in lists) and `tokenExpiresAt`.
8. **Token failure is a first-class state.** rclone errors are mapped to plain reasons (`invalid_grant`,
   `token expired`, `AADSTS70008`, `expired_access_token`, `401` after refresh). On any of them the destination status
   becomes **needs_reconnect**: backups to it fail with "Google Drive needs you to sign in again", a new alert event
   `storage.reconnect_needed` fires once per destination (deduped until reconnected), and the destination card shows one
   main button **Reconnect** which runs the same A/B/C flow and replaces only the token. Nothing polls the token: the
   state is found by the next real operation or **Test**.
9. **Semantics per backend**, shown on the destination card and checked by the readiness test:
   - Rename: Drive, OneDrive, Dropbox, WebDAV and SMB all support server-side move, so publish keeps `.partial` +
     rename. Drive allows two files with one name: readiness and every publish check `lsjson` for duplicates of the
     final name and fail closed if there is more than one.
   - Sync: no fsync exists; `syncFile` is a no-op and the upload counts as durable once rclone exits 0 and the provider
     hash (Drive MD5, OneDrive QuickXorHash, Dropbox content hash; WebDAV/SMB size) matches what DockNest streamed.
   - Append-only: **not available** on any of these backends; the card says so. Deleted files go to the provider's
     trash (Drive `--drive-use-trash`, OneDrive recycle bin, Dropbox deleted files), which is mentioned as a soft
     safety net, never as protection.
   - Capacity: `rclone about` (free and total) for Drive, OneDrive, Dropbox, WebDAV with quota support; otherwise the
     owner types a size, same rule as SFTP today.
   - Retention, extra copies, restore, restore tests from this destination and Move all use the facade, so they work
     unchanged. Restore tests that read from a cloud drive may be slower; recovery time shows that honestly.
   - Big files: Dropbox and OneDrive upload in chunks (rclone defaults); Drive uses resumable upload. File size limit
     per provider is checked before a backup starts and refused with the provider's limit named.
10. **Rate limits.** rclone runs with `--tpslimit 8`, `--retries 3`, `--low-level-retries 10`. A 403 rate limit after
    retries fails the step with "Google Drive is limiting requests, DockNest retries at the next run".

## Data model

No migration. A rclone destination is a `storage_targets` row with `auth_type = 'rclone'`, `host = 'rclone.invalid'`,
`port = 1`, `username = ''`, `host_key = 'not-sftp'`, `root` = the folder inside the drive. Its settings go to
`storage_target_settings` with `kind = 'rclone'`: `{ backend, account, driveId, driveType, endpoint (WebDAV/SMB),
vendor, clientIdSet, tokenExpiresAt, status }`. The facade gains `targetMode(row) === 'rclone'` when `auth_type` is
`rclone`. A local folder destination uses `auth_type = 'local'` the same way, settings `{ path }`.

## API

- `POST /api/storage-targets/rclone/authorize { backend, clientId?, clientSecret? }` -> `{ sessionId, url }` (admin,
  re-verification required). Starts the 10-minute session.
- `POST /api/storage-targets/rclone/authorize/:sessionId { pasted }` -> `{ account }` and a sealed pending token held in
  memory for the session only.
- `POST /api/storage-targets` gains `kind: 'rclone'` with `{ sessionId | token, backend, root, ... }` and `kind: 'local'`.
- `POST /api/storage-targets/:id/reconnect` reuses the authorize session and replaces only the credential.
- Existing `test`, `capacity`, `use for backups`, copies endpoints accept the new kinds.

## Helper changes

None. Storage is reached only from the DockNest container; servers never talk to cloud drives.

## Security and privacy

- Threat: a stolen DockNest data folder gives the attacker the drive token, just like SFTP keys and S3 secrets today.
  Mitigation is the same: the master key is outside `/data`; scopes are the narrowest each provider offers (Drive
  `drive.file`). The docs tell owners to use a dedicated account or app folder.
- The paste flow accepts only a `127.0.0.1:53682` address with the issued `state`; anything else is refused without
  being forwarded. The listener binds to loopback inside the container only.
- The rclone binary is verified by SHA-256 at build time and never self-updates.
- rclone stderr is parsed for known errors, then dropped; it can contain URLs with tokens. Logs and job text get only
  the mapped reason.
- Security review by a separate reviewer (Opus) is required for the adapter, the config file handling and the OAuth
  flow PRs.

## Upgrade safety

- No migration. Image size grows by the rclone binary (about 60 MB uncompressed); the Update Center shows the new size.
- Existing SFTP, S3 and local destinations behave exactly as before; `targetMode` checks the new auth types first and
  falls back to the old rule.
- **Downgrade**: 2.16.x treats an `auth_type = 'rclone'` row as SFTP. The sentinel host `rclone.invalid` never resolves
  and the credential is not an SSH key, so every operation fails closed with a connection error: no data is written
  elsewhere, nothing is deleted, retention cannot remove files from it. The 3.0.0 release notes say: "Before downgrading,
  move backups off cloud drive destinations or keep them unused until you upgrade again." The upgrade-compat suite gets
  a case for this.

## Test plan

- Unit: config writer and read-back (token refresh saved, file removed on error), duplicate-name refusal, error mapping
  table, paste-address validation (wrong host, port, state, extra params, fragments), confinement of paths, provider
  size limits.
- Linux Docker CI (`rclone-integration`, new required job, batched with the combined integration run): a WebDAV server
  container (rclone `serve webdav` from the same pinned binary, a separate container) and an SMB server container, plus
  a local folder on a second bind mount: full backup, publish, ranged read, restore, retention delete, extra copy,
  capacity, token-less failures. The full suite runs once on the combined integration branch.
- Upgrade-compat: a 3.0.0 database with a rclone destination opened by 2.16.4 fails closed (decision above).
- Live checks with free throwaway accounts that the owner connects once in the dev copy: Google Drive, OneDrive,
  Dropbox (backup, restore, Reconnect after revoking access in the provider's settings). **Pending live check**: needs
  the owner's accounts; work continues without it and these three are labelled Beta until it passes.

## PR split

1. Dockerfile rclone pin + checksum + readiness version check (small, backend).
2. `src/storage/rclone.js` adapter + config handling + error mapping + WebDAV/SMB CI job (security review, Opus).
3. OAuth authorize/paste/reconnect API + `storage.reconnect_needed` alert (security review, Opus).
4. Local folder destination (`DOCKNEST_LOCAL_STORAGE`) + compose docs.
5. Connect storage picker groups, OAuth dialog, Reconnect state on cards (UI, after board approval).
