# Keys safe

Some apps encrypt their data with a key kept in their settings, such as Laravel's `APP_KEY`. A restore without the same
key gives an app that starts but cannot read its own data. Keys safe finds these keys, proves that each one is inside
the last backup, and tells you when an app's Compose or env files change outside Safe Edit. DockNest never reads a key
value: it only sees keyed fingerprints. Design record: the 3.0.0 ADR "Keys safe" (sections 1 to 5).

## What it looks for

The rule list is plain data in `shared/key-rules.js`; the helper receives it with each request and keeps no copy.

| App | Where the key lives |
| --- | --- |
| Laravel, Firefly III | `APP_KEY` |
| n8n | `N8N_ENCRYPTION_KEY` |
| Rails apps (Mastodon, GitLab) | `SECRET_KEY_BASE`, `OTP_SECRET` |
| authentik | `AUTHENTIK_SECRET_KEY` |
| Paperless-ngx | `PAPERLESS_SECRET_KEY` |
| NextAuth apps | `NEXTAUTH_SECRET` |
| Outline | `SECRET_KEY`, `UTILS_SECRET` (only for Outline images) |
| Django apps | `SECRET_KEY` (only for known Django images) |
| Gitea | `SECRET_KEY` in `[security]` of `app.ini` |
| Nextcloud | `'secret'` in `config/config.php` |
| Vaultwarden | the file `rsa_key.pem` |

Environment keys are looked for in each container's environment, in the app's Compose files (inline `environment:`)
and in env files: configuration files named like `.env`, the `.env` beside a Compose file and every `env_file:` entry.
File keys are looked for in the app's configuration files and inside its mounts (a bounded search; `.ssh`, `.gnupg`
and mounts DockNest never copies are not read).

Adding an app: add one entry to `KEY_RULES` and a case to `tests/keys-safe.test.js` (the schema test checks it).

## Fingerprints, never values

- `fpKey = HKDF-SHA256(master key, salt = install id, info = "docknest key fingerprint v1" || 0x00 || server id)`: one
  key per server, so fingerprints from two servers cannot be linked. The API or worker derives it for one helper request
  at a time. It is never logged, stored or returned. The install id is a random id in the
  `settings` table, kept by a self-backup, so a recovered install keeps its fingerprints.
- A key's fingerprint is `HMAC-SHA256(fpKey, rule id || 0x00 || value)`, truncated to 128 bits (32 hex characters). A
  Compose, env or configuration file is fingerprinted whole the same way with the label `docknest-file`.
- The helper answers with rule ids, locations (`env:<container>` or `file:<path>`) and fingerprints only. The padlock
  shows the first 8 hex characters.

## Proof that a key is in the backup

At capture the helper fingerprints each key from the live source before anything stops, then from the bytes it wrote
into the package: the container environment in `manifest.json` and the member of the `config-N.tar` or mount archive.
A key is in the backup only when both fingerprints match. Otherwise it is missing, with a reason:

| Reason | Meaning |
| --- | --- |
| `not-included` | The key is in a file the app does not back up (for example an `env_file:` that is not one of its configuration files). Add the file to the app's configuration files. |
| `excluded` | The file lies in a path the app leaves out of its backups. |
| `differs` | The packaged bytes give another fingerprint (the key changed while the backup ran). |
| `not-in-package` | The key was not found in the package. An increment holds only changed files, so an unchanged key file stays proven by the earlier backup of the same chain. |

The proof list (rule, location, fingerprint, in backup, reason) is kept in the backup's metadata. A restore test sends
the proven keys to the test server, which fingerprints the same locations in the restored copy (the env each container
is created with, restored configuration files and restored mounts). All must match: then the test shows an "App keys"
check and the keys become "Verified in a restore test". A key that is missing or different in the restored copy fails
the test, because the restored app could not read its own data.

## Changed since last known-good

Each app's Compose, env and configuration files and each detected key are tracked in `config_fingerprints`. They are
checked on job events that already reach DockNest: a readiness check (which also runs the restore check), a discovery
and a backup. There is no timer. A discovery skips an app with work in progress (backup, restore, move, Safe Edit or
restore test), so its own work never reads as an outside change. The API never returns a backup's full proof list.

- The first observation of an item is its known-good baseline, silently. An upgrade or a new app never raises an alert.
- A different fingerprint marks the item changed, with the time first seen, and raises `config.changed` once per new set
  of fingerprints through your alert lines. Nothing about the content is compared or shown.
- Known-good is set by a Safe Edit that was applied (the files it wrote, from the full list kept with the edit, and the
  env of the services it recreated), a move onto a new server (a restore of a backup onto the app; the new server's key
  re-baselines the key fingerprints), or an administrator's **Mark as known-good** (`POST /api/sites/:id/keys/known-good`, which needs
  a sign-in re-verified in the last 5 minutes; refused while the app is busy and for static websites). A restore never
  sets it: it makes a separate copy and leaves the app as it is. Each first scans the app afresh and writes an audit entry that names the
  files and key names, never a value.
- A new master key (or install id) changes `fpKey`. Each app's next scan then re-baselines it silently, with one
  `keys.rebaselined` audit entry, so no false alert is raised. An item that was changed stays changed.

## Padlock

`/api/state` gives each app `keys: { state, keys, changed, knownGood }`, worst first:

| State | When |
| --- | --- |
| `red` | A key is missing from the last backup, or the app has no backup yet. |
| `amber` | A key changed after the newest backup, or a file or key changed since known-good. |
| `green` | Every detected key is in the last backup. |
| `none` | No keys detected and nothing changed. There is no grey padlock. |

Green means "found in the last backup", not "restorable"; only a restore test that matched says "verified". Static
websites have no keys and no Compose files, so they are not scanned.

## Data

Migration 24, additive and compatible: `app_keys` (site, rule, location, fingerprint, in backup,
verified test, first seen, changed at) and `config_fingerprints` (site, item, fingerprint, known-good, its source and
time, first seen changed, alerted fingerprint). Both start empty.

## Tests

- `tests/keys-safe.test.js`: the rule list schema, the fingerprint key and a known answer shared with the helper, the
  silent baseline, `config.changed` once, Safe Edit and administrator known-good, the re-baseline, the padlock table,
  the backup and restore test proof, and a known value, its SHA-256 and its base64 never in the API, audit, alerts, jobs
  or logs.
- `remote/test_keys.py`: env, ini, php-array and file detection, fingerprints of packaged bytes, restored fingerprints
  and no value on helper stdout.
- `scripts/integration-keys-safe.js` (Linux Docker): a Laravel-style app with `APP_KEY` in `.env` (in the backup) and
  `SECRET_KEY_BASE` in an un-included `env_file` (missing), a restore test that verifies, and a hand edit that raises
  `config.changed` exactly once.
