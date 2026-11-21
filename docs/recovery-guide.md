# Recovery Guide

If you are not around, someone you trust has to find the backups and bring the apps back, or hand the job to someone
who can. The Recovery Guide is that hand-over: plain, numbered steps made from what DockNest knows right now, as a page
for administrators and as a PDF you print or keep with the emergency kit.

The **Recovery Guide** page in the menu shows the guide, says when it is out of date or has steps that are not verified, and has one text link, "Download Recovery Guide (PDF)", which opens the dialog where you choose the apps and what goes in.

## What is in it

The guide is made from the database each time you ask for it. In this order:

1. **Start here:** get a new server, install DockNest (the same version, from its release tag), open the recovery kit
   and connect the backup storage.
2. **Restore everything in this order:** one numbered list of the apps. With linked apps, an app whose
   database other apps use comes first, then the apps that use it, then the rest. Each line says why.
3. **Fleet overview:** what DockNest is for, who to ask (your note), the servers and what runs there, the apps with their
   last good backup and last restore test, where the backups are, and the emergency kit.
4. **One page per app:** what it is, how to tell it works, what to do if it is down, how to restore it with DockNest,
   and, for someone who knows Linux, the same restore without DockNest.

Every step is one short sentence that starts with a verb. Where a step has a command, the exact command follows in a
monospaced box, made from DockNest's own records: the real backup file of that app on its storage, its Compose files,
folders and containers. The commands follow [independent recovery](independent-recovery.md): download with curl (a pinned curl image, run with Docker, as many servers' own curl has no SFTP) over
SFTP (first `ssh-keyscan`, from a pinned image, keeps only the storage server key whose SHA-256 DockNest pinned,
and nothing is sent unless it matches; curl then checks that key again) or signed S3 requests, decrypt with the recovery kit's
`decrypt-backup.js`, load the saved images, put each data folder and settings file back where it was (files already
there are kept; a Docker named volume is created on the new server with `docker volume create` and filled through the
folder `docker volume inspect` names, wherever that server keeps its volumes, and keeps the owner and mode it had), then start the app (`docker compose up -d` for a Compose project, the saved snapshot for a single
container, an nginx reload for a static website). An incremental backup uses `decrypt-backup.js --chain` and
`helper.py restore-chain`. The check commands show the containers, ask each database DockNest knows (PostgreSQL, MySQL,
MariaDB, Redis, MongoDB) whether it answers, run `PRAGMA integrity_check` on each SQLite file and open each domain over HTTPS.

**Honest wording.** An app reads **Verified** only when its newest backup passed an automatic restore test, with the
date and whether the test used the main backup or the off-site copy. Otherwise it reads **Backed up, not tested yet**,
or **Not backed up yet**. With [Keys safe](keys-safe.md), each app page says how many of its keys the newest backup holds and lists each
missing or changed key, and files changed since known-good, as a known gap. It never shows a key or its fingerprint.

**The emergency kit** reads as it really is: "One kit, opened with your recovery passphrase", or, with the optional
[split](emergency-kit.md), how many of the people together can open it, their labels and the key digest each part
shows. With the split on, Start here copies the `docknest-recovery/emergency/` folder from the storage (the offline tool
`emergency-open.js` is in it), the holders type their parts into it, and the recovery kit it gives is opened as usual.
It never holds a part, the recovery passphrase, the master key or the servers' SSH keys.

## Download (PDF)

`POST /api/runbook/pdf` with `{ "apps": [<app ids>], "include": { ... } }`, for administrators:

| Option | Default | What it adds |
|---|---|---|
| `addresses` | off | Server and storage addresses. Off, commands show `<storage-address>`. |
| `logins` | off | The backup storage logins DockNest keeps sealed (SFTP user and password or key, S3 bucket and keys) and your login notes per app. Off, commands show `<storage-user>`, `<storage-password>` and so on. Needs a re-verification in the last 5 minutes, checked on the server. Every page is then marked "Contains secrets". |
| `commands` | on | The command boxes. |
| `tests` | on | Restore test results. |
| `schedules` | on | Backup schedules. |
| `notes` | on | Your "who to ask" note. |

The answer is the PDF as a download (`Content-Disposition: attachment`, `Cache-Control: no-store`). It is made in
memory and never written to disk, kept or logged. The audit log records who made it, when, the app ids and the options,
never the content. At most 200 apps, 2,000 pages and 64 MB.

The PDF is written by DockNest itself (`src/runbook/pdf.js`, PDF 1.7, no extra package). Its fonts are Roboto, Roboto
Mono and Noto Sans Hebrew (in `assets/fonts/`, SIL Open Font License), embedded so the text can be selected and searched.
Hebrew and other right-to-left text is laid out right to left, also when it is mixed with English words and numbers on
one line. Commands are folded to fit the box, measured with its font, with a `\` at the end of the line, so they still work when
copied; a command line is never wrapped any other way. The PDF
has no scripts, forms, attachments or links.

## Login notes

For each app you can keep a note on how to sign in to the app itself, for the person who restores it:
`POST /api/runbook/apps/:id/login-note { "note": "..." }` (at most 4,000 characters; an empty note removes it). Only
administrators who re-verified in the last 5 minutes can write one, checked on the server. It is sealed with the master
key and bound to its app (`app_login_notes`), never sent back by the API (the page data says only whether an app has
one), never logged, and the audit entry names the app only. It is in a PDF only when login details are included,
inside the "Contains secrets" marking, and never in the copy next to the kit.

## Copy next to the kit

After each completed Self Backup, DockNest also writes the guide for every app as a PDF next to the recovery kit, in
`docknest-recovery/` on each storage that got the kit (`recovery-guide_<time>--<backup id>.pdf`). A relative can read it
before anything is decrypted. This copy never holds addresses or login details, whatever was chosen for the last
download. A newer copy replaces the older one once it is verified; a failure never fails the Self Backup.

## Out of date

When you download a guide, DockNest keeps a digest of what it was made from: the servers (names and addresses), the
apps (names, servers and domains), the storage and copies, the schedules, each app's newest restore test result, the
emergency kit split and your note. It keeps only hashes, never the values. When any of them changes, the page says
"This Recovery Guide is out of date" and what changed (an app was added, a server address changed, and so on), and the
Overview shows one quiet line. There is no timer: DockNest compares after each change to servers, apps, storage, Self
Backup or your note, and after each restore test. With an alert rule for **Recovery Guide out of date** (`runbook.outdated`), each new change is sent once.

## API

All for administrators; other roles get 403.

- `GET /api/runbook`: `{ made, madeAt, madeBy, outdated, changes: [{ code, label }], notes, guide }`. `guide` is the
  whole guide for every app, without addresses or login details.
- `POST /api/runbook/notes` `{ "notes": "..." }`: your "who to ask" note, at most 4,000 characters.
- `POST /api/runbook/apps/:id/login-note`: an app's login note (above).
- `POST /api/runbook/pdf`: above.
- `GET /api/state` gives administrators `runbook: { made, outdated }`.

Stored in `runbook_state` (one row): the digest and per-part hashes of the last downloaded guide, when and by whom it was
made, and your note; and in `app_login_notes`, the sealed login notes. Both arrive with migration 25.

## Verification

`tests/runbook-pdf.test.js` (pinned font files, PDF structure, escaping, bidi and the ToUnicode round trip),
`tests/runbook-commands.test.js` (quoting and folding through a real shell, each kind of app and database) and
`tests/runbook.test.js` (the API, redaction, out of date, the copy next to the kit). On Linux,
`scripts/integration-runbook.js` checks a PDF with `qpdf --check` and `pdftotext`, and runs the printed restore
commands of two Compose demo apps on a clean Docker host, one with a bind-mounted folder and one with a Docker named
volume, which bring both apps back with their data.

Selected upstream references: [Technical Writer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-technical-writer.md)
for the plain steps, [Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md)
for redaction and the login option, and [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md)
for "Verified" only with evidence.
