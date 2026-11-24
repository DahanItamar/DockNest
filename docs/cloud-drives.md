# Cloud drives as backup storage

DockNest 3.0.0 can keep backups on Google Drive, OneDrive, Dropbox, a WebDAV server (Nextcloud, ownCloud and others) or an
SMB share. The transport is a bundled [rclone](https://rclone.org). DockNest encrypts every package before it reaches
rclone, so rclone only ever moves ciphertext; rclone's own `crypt`, daemon and mount are not used.

This page covers the backend and the screens.

## The screens

Storage, **Add storage destination**: the provider list has the groups Cloud drives (Google Drive, OneDrive, Dropbox) and Network and local (WebDAV, SMB share, Local folder) after SFTP and S3, with each provider's own Tabler mark where one exists. For a cloud drive the dialog shows the two steps: open the sign-in link, then paste the address that failed to load. Two quiet links switch to a token pasted from rclone, or to your own app ID. OneDrive asks which drive when the account has more than one. The card shows the masked account, the folder, "Append-only: Not available on Google Drive", the trash note and the space DockNest uses. When the token stops working the card says **Needs sign-in**, a red panel says backups are paused, and **Reconnect** is the card's main button; it replaces only the token. The Map shows the same icon on the storage node. A local folder shows the compose lines to copy and stays off until a folder path is entered.

## How it works

- One `rclone` process per operation (`rcat`, `cat --offset --count`, `moveto`, `lsjson --stat`, `deletefile`, `rmdir`, `mkdir`,
  `about`). Nothing runs between operations and nothing polls a token.
- Publishing keeps the same steps as every destination: write `<name>.partial`, check it, rename, check again. These
  providers have no fsync, so an upload counts as durable once rclone exits 0 and the provider's size (and Google Drive's MD5)
  matches the bytes DockNest sent. DockNest's own SHA-256 read-back still decides.
- Google Drive allows two files with one name, so every publish counts the name and stops when it is not exactly one.
- Not append-only on any of these providers. Deleted files go to the provider's trash, which is a soft safety net only.
- Rate limits: `--tpslimit 8 --retries 3 --low-level-retries 10`. A limit that outlasts the retries fails the step with
  "Google Drive is limiting requests, DockNest retries at the next run".

## Where secrets live

- Token JSON, the owner's own client secret and WebDAV or SMB passwords are sealed with the master key in
  `storage_targets.credential`, like SFTP keys and S3 secrets. The API never returns them: it returns `connected`,
  `needsReconnect`, a masked `account` and `tokenExpiresAt`.
- For each operation DockNest writes a temporary `rclone.conf` (mode 0600) into a private folder under `DATA_DIR/tmp/rclone-*`,
  passes `--config`, reads the token back (a refreshed token is sealed and saved) and deletes the folder in a `finally`.
  Arguments never contain a secret (passwords are obscured through stdin). rclone gets a minimal environment: no `RCLONE_*`
  from the container.
- rclone's stderr is matched against known failures and dropped. Logs, job text and API errors carry only the mapped reason.

## Signing in (OAuth providers)

1. `POST /api/storage-targets/rclone/authorize { backend, flow?, clientId?, clientSecret? }` (admin, recent verification) returns
   `{ sessionId, url }`. With `flow: "address"` (default) DockNest starts `rclone authorize` on `127.0.0.1:53682` inside the
   container and returns the provider's sign-in address. Only one address sign-in can be open; it ends after 10 minutes.
2. The owner signs in in their own browser. The provider redirects to `http://127.0.0.1:53682/...`, which does not open on
   their computer. They copy that address and paste it:
   `POST /api/storage-targets/rclone/authorize/:sessionId { pasted }`. DockNest accepts only host `127.0.0.1`, port `53682`,
   path `/`, no credentials or fragment, the issued `state`, and `code` and `state` once each (a provider's `scope`,
   `authuser` and `prompt` are read and ignored). It builds the request itself from `code` and `state`, sends it to the
   local listener and keeps the resulting token, sealed, in memory for the session.
3. Alternatively `flow: "token"`: paste the JSON that `rclone authorize "drive"` printed on the owner's computer. Only
   `access_token`, `token_type`, `refresh_token`, `expiry` (and a numeric `expires_in`) are accepted.
4. The owner's own app (client ID and secret, strongly recommended for Google Drive: the shared sign-in app has one request limit for everyone, so Google answers `rateLimitExceeded` and a test can take minutes; DockNest then says "Google is limiting the shared sign-in app. Use your own Google app ID for steady speed.") goes to the helper through its environment.
5. `POST /api/storage-targets/rclone/connect` creates the destination from the session (OAuth) or from a login (WebDAV, SMB),
   tests it and saves it. Scopes: Drive `drive.file`, OneDrive `Files.ReadWrite` + `offline_access`.

## Reconnect

A real operation or **Test** that finds `invalid_grant`, `token expired`, `AADSTS70008`, `expired_access_token` or a 401 after
refresh sets the destination to `needs_reconnect` once. Backups to it fail with "Google Drive needs you to sign in again", the
alert `storage.reconnect_needed` fires once per outage, and `POST /api/storage-targets/:id/reconnect { sessionId }` replaces
only the token and clears the state after a passing test.

## Data model

No migration. A destination is a `storage_targets` row with `auth_type = 'rclone'`, `host = 'rclone.invalid'`, `port = 1`,
`host_key = 'not-sftp'`; its settings (`backend`, `account`, `driveId`, `driveType`, `endpoint`, `vendor`, `host`, `share`,
`tokenExpiresAt`) are in `storage_target_settings` with `kind = 'rclone'`.

**Downgrade:** 2.16.x reads such a row as SFTP. The sentinel host never resolves and the credential is not an SSH key, so every
operation fails closed. Before downgrading, move backups off cloud drive destinations or keep them unused until you upgrade.

## The rclone binary

The Docker image downloads one pinned `linux/amd64` release, checks its SHA-256 against the value in the `Dockerfile` (taken
from the release's signed `SHA256SUMS`; verify the PGP signature of that file when the pin is bumped) and copies only the
binary to `/usr/local/bin/rclone`. `rclone selfupdate` and `rclone version --check` are never run. Other CPU architectures get no
binary and cloud drive destinations say so. Source installs need rclone on `PATH` at the pinned major.minor or newer
(`DOCKNEST_RCLONE_BIN` can point elsewhere).

## A folder on a USB disk or NAS

A folder mounted into the container can be a destination too (no rclone involved). Mount it in `compose.override.yaml` and list its
parent in `DOCKNEST_LOCAL_STORAGE` (comma separated), for example:

```yaml
services:
  docknest:
    environment:
      DOCKNEST_LOCAL_STORAGE: /backups/usb
    volumes:
      - /mnt/usb-disk:/backups/usb
```

`POST /api/storage-targets/local/connect { name, path, root?, acceptSameDisk? }` accepts a folder only when its real path is inside
a listed parent, is not inside (or around) the DockNest data folder, exists and is writable. When it is on the same disk as
`/data` the answer is `409 { code: "same_disk" }` and the folder is added only after the owner repeats the request with
`acceptSameDisk: true`. Every path is resolved against the real folder, so a symbolic link cannot lead out of it. A destination is a
`storage_targets` row with `auth_type = 'local'` and settings `{ path, sameDisk }`; it is not append-only.
