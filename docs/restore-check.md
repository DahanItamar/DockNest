# Restore check: will a restore on a new server really work?

Design and decisions: [coverage and restore check](coverage-and-restore-check.md).

A backup copies an app's containers, volumes, bind mounts and the configuration files you selected. Some things an app
needs live elsewhere on the server: a cron job that rotates its logs, a systemd timer that runs its backup script, a
Docker network another project created, a certificate in `/etc/letsencrypt`. They are not in the backup, so a restore
on a new server starts without them.

**Check readiness** now also lists these things in its result, as `restoreGaps`. The check reads only; it never changes
the server, and it never changes whether the site is ready to back up.

## Where you see it

Sites & schedules, an app's **Check readiness** button. The dialog keeps its check list as before; below it a section
**Restore on a new server** lists what the scan found, from the same readiness answer (no second request). Each row
has at most one quiet link and a **More actions** menu:

- **Save a copy in backups** (administrators; operators see it disabled with "An administrator can add this"). It saves
  a copy in the backup; the restore guide says where to put it back by hand, and a move never writes into `/etc`. A
  finding already in the backup shows **Saved in backups**.
- **Ignore**, **Note** (up to 500 characters) and **Undo** in the menu, for administrators and operators.
- No findings: "Nothing outside the app folder that a new server would miss". An incomplete scan says "The scan
  stopped early; there may be more". A failed scan shows its message; an answer without `restoreGaps` (an older
  helper) shows no section.

Browser test: `npm run test:restore-check`.

## What it finds

The app's folders are its Compose project folders, the folders of its Compose files, its configuration files, its mount
sources and, for a static site, its website folder. Shared folders such as `/etc`, `/srv` or `/var/www` on their own do
not count, and nor do `/proc`, `/sys`, `/dev` and `/run`.

| Kind | What it means | Found in |
|---|---|---|
| `host-schedule` | A scheduled task uses an app folder, or runs a `docker` command that names one of the app's containers or its Compose project. | `/etc/crontab`, `/etc/cron.d/*`, `/etc/cron.{hourly,daily,weekly,monthly}/*`, users' crontabs (`/var/spool/cron/crontabs`, `/var/spool/cron`, `/etc/crontabs`), and `*.timer` units in `/etc/systemd/system` with their service's `ExecStart*`, `WorkingDirectory`, `ReadWritePaths` and `EnvironmentFile` |
| `external-network` | The app uses a Docker network that its own Compose project did not create (a plain `docker run` container never creates its network). | `docker inspect` of the containers and networks (`com.docker.compose.project` label) |
| `external-volume` | The app uses a named volume that its own Compose project did not create. Its data is copied; the volume itself must exist before a Compose start. | the same, for volumes |
| `bind-outside` | A bind mount lies outside the app's Compose project folder. Informational: it is copied, and a restore puts it back at the same path. | container mounts |
| `secret-or-config` | A Compose secret or config reads a file outside the project folder, or is external (kept by Docker, not in a file). | `docker compose config` |
| `env-file` | A Compose `env_file` lies outside the project folder. | `docker compose config` |
| `certificate` | certbot's folder for one of the app's domains, or a certificate file its nginx site names. | `/etc/letsencrypt/live/<domain>`, `ssl_certificate` and `ssl_certificate_key` in the nginx server blocks of the app's domains |

Compose files are read the way Safe Edit reads them: `docker compose config` with no interpolation, no environment or
path resolution and no remote includes. Values never leave the helper; only paths and names do.

## What a finding holds

```json
{"key": "<64 hex>", "kind": "host-schedule", "path": "/etc/cron.d/shop", "line": 2, "schedule": "*/5 * * * *",
 "matched": "/srv/shop/data", "includable": true, "includePaths": ["/etc/cron.d/shop"], "included": false,
 "message": "A scheduled task in /etc/cron.d/shop uses this app's folder /srv/shop/data; ..."}
```

- `key` is the SHA-256 of kind, path and match, so it stays the same when the line moves.
- `path` is a file or folder, or the name of a Docker network, volume or external secret.
- `line` and `schedule` (a cron expression, `daily` for `/etc/cron.daily`, or a timer's `OnCalendar`) are given when
  they exist. For a timer, `path` is its service file.
- `matched` is the app folder, container or Compose project that matched.
- `includable` is true only for files the backup itself accepts as configuration files: regular files, not links, not
  protected, on a local filesystem, at a path the site form accepts. `includePaths` lists what to add (a timer needs
  both its `.timer` and `.service` file). `included` is true when they are already in the site's configuration files.
- `decision` and `note` are the stored answer, when there is one.

**Never in a finding:** the command, the line text or any value from these files. A cron line often carries a token;
the check reads it only to find paths and names. Nothing read is logged.

The result also has `complete` and `limits`. The check reads at most 400 files, 256 KB of each, and keeps at most 100
findings. It does not follow a link out of the folder it scans (a masked unit, a link to `/dev/null`, is skipped) and
skips every path the backup itself never copies (`.ssh`, `.gnupg`, password files, sudoers). `complete` is false when a
limit was reached, a link was skipped, a file could not be read or a Compose project could not be read. When the
check fails as a whole, `restoreGaps` is `{"error": "<plain message>"}` and the rest of the readiness result is as
before.

## Answering a finding

- **Include in backup** (administrators) adds `includePaths` to the site's configuration files through the normal
  site update, so a copy of each file is saved in every backup. The same rules as for any configuration file apply:
  the site update refuses operators a path discovery did not find (403 `ADMIN_REQUIRED`), and the helper refuses
  protected paths at readiness, planning and capture. Nothing puts these files back by itself:
  - the backup's `restore-guide.md` (also in a ZIP export, under `recovery-originals/`) gets a **Put back by hand**
    section: `copy <file> (config-N.tar) from the backup to <original path>`, for each configuration file outside the
    folders a move may create;
  - a move leaves out exactly the files its preview names as a note (never a blocker) and never writes into `/etc`
    ([moving sites](moving-sites.md));
  - an isolated restore or restore test unpacks configuration files into its own restore folder for review, as
    always, and never at their original path.
- **Ignore** or **Note**: `PUT /api/sites/:id/restore-decisions/:key` with `{"decision": "ignore"}` or
  `{"decision": "note", "note": "..."}` (at most 500 characters), `DELETE` the same path to take the answer back.
  Administrators and operators may answer. The audit trail records the key and the answer, never the note.

Answers are kept in `site_restore_decisions (site_id, finding_key, decision, note, decided_by, decided_at)`, one row per
site and finding (migration `site-restore-decisions`, 19, compatible). Sites are archived, never deleted, so answers
stay with the site's history.

## Upgrade safety

- One new table in its own compatible migration (19); older releases ignore it.
- `readiness` gains one field. A helper that does not send it leaves the API answer without `restoreGaps`.
- A backup's `restore-guide.md` gains a **Put back by hand** section when it holds configuration files outside the
  folders a move may create. Nothing else in a backup or restore changes.
- A move leaves out only the configuration files its reviewed preview named to put back by hand: for those, the
  refusal it gave before becomes a named skip. Every other file, including the project's Compose files, files inside
  bind mounts and a path that only becomes a link on the new server, refuses exactly as before. A preview saved
  before the upgrade names no files, so its move runs as it always did. Nothing else moves differently.

## Tests

- `remote/test_restore_gaps.py`: cron and timer matching, a token on a cron line never appearing in the result or the
  helper's output, links and protected paths, limits, Compose networks, volumes, secrets, configs and env files,
  certificates, and readiness staying the same when the check fails.
- `tests/restore-decisions.test.js`: the answer routes, the readiness join and migration 19.
- Linux Docker integration (`scripts/integration-restore-check.js`): a cron.d file and a systemd timer touching the app
  and a user network are found through Check readiness; the cron token is absent from the result, the audit trail and
  the logs.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md)
for what may leave the server and the read limits, and
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for extending Check readiness instead of adding a parallel scan.
