# ADR: Keys safe (3.0.0)

Status: proposed. Index and audit: [3.0.0 design](design-3.0.0.md). There is no secrets vault in this design.

## Context

Some apps encrypt their data with a key held in their environment, such as `APP_KEY`, `N8N_ENCRYPTION_KEY` or
`SECRET_KEY_BASE`. Restoring the data without the same key gives an app that starts but cannot read its own data.
Today a backup carries the container environment (in the encrypted manifest) and the configuration files chosen.
Nothing proves that a named key made it in, and nothing notices when Compose or env files change outside Safe Edit.

## Decision

### 1. Key rules: `shared/key-rules.js`

The list is plain data, so adding an app is one entry with a test:

```js
{ id: 'laravel-app-key', app: 'Laravel', kind: 'env', name: 'APP_KEY' },
{ id: 'n8n-encryption-key', app: 'n8n', kind: 'env', name: 'N8N_ENCRYPTION_KEY' },
{ id: 'rails-secret-key-base', app: 'Rails apps', kind: 'env', name: 'SECRET_KEY_BASE' },
{ id: 'gitea-secret-key', app: 'Gitea', kind: 'ini', file: 'app.ini', section: 'security', name: 'SECRET_KEY' },
{ id: 'nextcloud-secret', app: 'Nextcloud', kind: 'php-array', file: 'config/config.php', name: 'secret' },
{ id: 'vaultwarden-rsa', app: 'Vaultwarden', kind: 'file', path: 'rsa_key.pem' },
```

- **Kinds:** `env` (container env or an env file), `ini`, `php-array`, `file` (the file must exist; its bytes are
  fingerprinted). Optional `image` hints narrow a generic name such as `SECRET_KEY` to known images, to avoid noise.
- **Seed list:** Laravel or Firefly III `APP_KEY`, `N8N_ENCRYPTION_KEY`, `SECRET_KEY_BASE` and `OTP_SECRET`
  (Mastodon, GitLab), `AUTHENTIK_SECRET_KEY`, `PAPERLESS_SECRET_KEY`, `NEXTAUTH_SECRET`, Outline `SECRET_KEY` and
  `UTILS_SECRET`, Django `SECRET_KEY` (image hint), Gitea, Nextcloud, Vaultwarden.
- **Matching:** the helper receives the rule list in the request; DockNest is the single source. It reports only
  rule ids, where each key was found (env, file path, service) and fingerprints.

### 2. Fingerprints, never values

- **The key:** `fpKey = HKDF-SHA256(master key, salt = install id, info = "docknest key fingerprint v1")`. It is
  derived in the API or worker, sent to the helper inside the SSH request for that one operation, never logged and
  never stored on the server.
- **The fingerprint:** `HMAC-SHA256(fpKey, rule id || 0x00 || value)`, truncated to 128 bits and stored as hex. The
  UI shows the first 8 hex characters as `3a9c 71e2`.
- **Why keyed:** a plain hash of a weak secret can be guessed offline from a leaked database. A keyed fingerprint
  needs the master key too.
- **Equality:** the same value always gives the same fingerprint in one install, which is all the comparison needs.
  Values never cross into DockNest, the database, the audit trail or logs.

### 3. Proof that the key is inside the backup

- **At capture:** the helper fingerprints each key twice, from the live source (container env, env file, config file)
  and from the bytes it writes into the package (the manifest env and the `config-N.tar` member). The result is
  `inBackup: true` only when both match.
- **Not covered:** a key in a file outside the configuration files gives `missing`, with the file path and an "Add
  file" action. That action is the restore check's "Include in backup" (#204), so it is not duplicated.
- **Restore test:** the test compares the restored container's env or file fingerprint. Passing is the only case that
  may say "Verified in a restore test".

Wording levels, used everywhere (Map, card, runbook):

| State | Text |
|---|---|
| captured and matched | "In last backup" |
| restore test matched | "Verified in a restore test on 12 Nov" |
| missing | "Missing from last backup" plus the reason |
| changed after the newest backup | "Changed 2 days ago, newer than the last backup" |

### 4. Changed since last known-good

- **What is tracked:** fingerprints of the app's Compose files, env files and configuration files (whole-file
  HMAC), and of each detected key. Files are fingerprinted whole because Compose files can hold inline secrets.
- **When it is checked:** on job events that already reach the server (readiness, discover, backup, restore check).
  There is no timer.
- **First run is silent:** the first observation of an item becomes its known-good baseline without an event. So an
  upgrade, or adding an app, never causes an alert storm.
- **Who sets known-good:**
  - a successful Safe Edit apply (source `safe-edit`), for the files it wrote;
  - a restore of a backup onto that app (source `restore`);
  - an administrator's "Mark as known-good", with re-verification and an audit entry that names files and key names,
    not values.
- **The event:** a different fingerprint gives `config.changed` ("Compose or env files of Wiki changed outside Safe
  Edit"), sent once per new fingerprint set and routed by the existing alert rules. The UI shows "Changed since last
  known-good" with the time first seen. Content is never compared or shown (no diff, by owner decision).

### 5. Padlock state

Each app gets a padlock state, worst first:

| State | Icon | When |
|---|---|---|
| red | `IconLockX` | a required key is missing from the last backup |
| amber | `IconLockExclamation` | a changed item has no known-good, or a key changed after the newest backup |
| green | `IconLockCheck` | every detected key is in the last backup |
| none | no badge | no keys detected; never a grey padlock that suggests safety |

The state is computed in `/api/state` from `app_keys` and `config_fingerprints`. It shows on the Map node, the app card
and the app panel.

### 6. Move pre-flight: ownership, modes and filesystem

This extends the restore check vocabulary (#204, `restore_gaps.py`) rather than adding a parallel scan. The Move
preview asks the target helper for three new finding kinds:

- **`owner-map`:** the target Docker daemon uses `userns-remap` or rootless mode, or the source runs it and the target
  does not. Numeric UID/GID stay as they are in the archive, but the owners the container sees change. This is a
  warning.
- **`file-mode`:** the source paths have setuid or setgid bits, or ACLs or xattrs, and the target filesystem does not
  support them (tested on a probe file in the staging folder). This is a warning that names the path.
- **`target-filesystem`:** the target bind path's mount is `noexec`, `nosuid`, read-only or NFS with root squash, or a
  bind path already exists and is not empty. The existing refusal (`move.py:342`) becomes a named preview finding
  before the move starts, and stays a block.

Findings use the restore check shape (`key`, `kind`, `path`, `message`, never file content) and can be answered with
Ignore or Note in the same `site_restore_decisions` table.

### 7. Scheduled recovery kit decrypt proof

After every successful self-backup, and on "Check now", the worker opens the newest kit in a 0700 temp folder with the
sealed passphrase. It checks the kit's own hashes, runs SQLite `integrity_check` on `state.sqlite`, and confirms that the
kit's master key equals the live one (comparing SHA-256 values). It then removes the folder. The result goes in
`kit_checks` (time, result, reason code).

Honest wording: "Opened on 18 Nov with the passphrase DockNest keeps. This cannot prove your own copy of the
passphrase is right." A failure raises `selfbackup.kit_check_failed`.

### Data (compatible migrations, numbered at build time)

- `app_keys`: `site_id`, `rule_id`, `location`, `fingerprint`, `in_backup` (backup id or null), `verified_test_id`,
  `first_seen_at`, `changed_at`.
- `config_fingerprints`: `site_id`, `item` (path or key rule id), `fingerprint`, `known_good`, `known_good_source`,
  `known_good_at`, `first_seen_changed_at`, `alerted_fingerprint`.
- `kit_checks`.

## Security review notes

- **Values:** they never leave the helper. Fingerprints are keyed (HKDF from the master key), truncated, and never
  derived from short inputs without the key. Tests assert that a known value, its SHA-256 and its base64 never appear
  in the API, the audit trail, logs or helper stdout.
- **`fpKey` in transit:** it rides inside the SSH channel with pinned host keys, as backup requests already carry
  sealed data. A compromised server sees the key values anyway, so `fpKey` gives it no new power. `fpKey` is per
  install, so fingerprints cannot be linked across installs.
- **Master key rotation:** rotation changes `fpKey`. The next run re-baselines silently, with an audit entry, so no
  false alerts are raised.
- **Known-good is a trust decision:** only an administrator with fresh re-verification can mark it. Operators can see
  it but not change it.
- **Kit check:** the temp folder is 0700 under the worker's private tmp, with a size cap equal to the export limit
  (128 MB, `recovery-kit.js:9`). It is removed in `finally`, and the passphrase is only in memory.
- **Padlock honesty:** green means "found in the last backup", not "restorable". "Verified" needs a restore test.

## Tests

- JS: rule list schema, the padlock state table, the silent baseline on first run, no event after the upgrade
  fixture, Safe Edit known-good, re-baseline after key rotation.
- Python: env, ini, php-array and file detection, fingerprints of packaged bytes, a value never in stdout, and the
  `owner-map`, `file-mode` and `target-filesystem` probes.
- Linux integration: a Laravel-style app with `APP_KEY` in `.env` (in backup) and one in an un-included file
  (missing), a restore test that verifies, a change made by hand that raises `config.changed` once, and a Move to a
  `userns-remap` target that names the ownership note.

## Roles used

[Secrets and Credential Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-secrets-credential-engineer.md)
for the fingerprints and the value boundaries.
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for extending the restore check.
