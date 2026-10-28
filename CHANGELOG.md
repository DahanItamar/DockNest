# Changelog

All notable changes to DockNest are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and DockNest uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [docs/upgrading.md](docs/upgrading.md) describes what stays stable within a major version and the deprecation policy. Detailed notes for each release live in [docs/releases](docs/releases).

## [Unreleased]

### Fixed

- Update Center: after an update from the command line, in-app updates no longer fail with "cannot confirm which version is installed". When `scripts/upgrade.sh` already runs as root (a root-owned checkout), it registers the new version with the host updater itself. Otherwise run `sudo scripts/install-updater.sh --repair` after a command-line upgrade; the script and the Update Center both show that command, and `--repair` also clears an earlier refusal.

## [2.11.0] - 2026-10-28

See [docs/releases/2026-10-28-v2.11.0.md](docs/releases/2026-10-28-v2.11.0.md).

### Added

- Storage per site: a site can use its own main backup destination instead of the default one.
- Backup copies: keep up to three extra copies of each backup on other destinations (for example SFTP plus S3). Copies follow in the background, retry on failure, send alerts, keep their own retention and can be used to restore if the main copy is gone.

### Changed

- S3-compatible storage is no longer beta.
- Storage report: the **Incremental saving** card is now **Possible saving**, so it is clear DockNest does not make incremental backups yet; the number is a best-case estimate of what they could save.

### Fixed

- Storage: two fast Enter presses in Connect storage no longer post the form twice.
- ZIP downloads always contain regular files, whatever file type a backup package claims.

## [2.10.1] - 2026-10-28

See [docs/releases/2026-10-28-v2.10.1.md](docs/releases/2026-10-28-v2.10.1.md).

### Changed

- Storage: **Add storage destination** now opens in a dialog instead of a form at the bottom of the page.

### Removed

- The **System health** card in the sidebar.

### Fixed

- New connection: opening the Provider list no longer leaves the dialog looking empty and unclickable. The list now opens right under the field.

## [2.10.0] - 2026-10-27

See [docs/releases/2026-10-27-v2.10.0.md](docs/releases/2026-10-27-v2.10.0.md).

### Added

- Alert channels: alerts can now go to 13 providers. Telegram and Email are joined by WhatsApp (Meta WhatsApp Cloud API, with an approved template by default), Discord, Slack, Microsoft Teams (Workflows), Google Chat, Mattermost, ntfy, Gotify, Pushover, Matrix and "Other (webhook URL)" under Advanced. One message template for all of them: a title, the site and server, a plain reason and a link that opens the job after sign-in.
- Administration, **Connections**: one page for the logins your alerts use, with Used by, Last test, Send test, Edit (secrets are "Saved, hidden" and can only be replaced) and Delete (refused while a node uses it). A warning shows when a real alert could not be sent. Two settings, both off by default: **Allow private network** (for a self-hosted ntfy, Gotify, Matrix or Mattermost) and **Operators can manage alerts**. On the Map an alert node is now a provider plus a Connection; delete a node with the Delete key or the icon on its corner. Existing Telegram and Email alerts keep working with no action. See [docs/alerts.md](docs/alerts.md) and [docs/upgrading.md](docs/upgrading.md).

### Deprecated

- `channelId` in `/api/alerts/rules`: use `nodeId`. The old name is still accepted in this release.

### Removed

- The 2.8 alert routes `/api/alerts/credentials` and `/api/alerts/channels`. Use `/api/connections` and `/api/alerts/nodes`.

### Changed

- The Storage page has a cleaner, balanced layout: summary tiles, sites by size, a growth chart that starts when your history starts, and destination cards with their capacity used. Sizes now read the same everywhere in DockNest, in decimal units (1 GB = 1,000 MB, 1 TB = 1,000 GB), so a 2 TB destination shows as 2 TB.

## [2.9.0] - 2026-10-27

See [docs/releases/2026-10-27-v2.9.0.md](docs/releases/2026-10-27-v2.9.0.md).

### Added

- Automatic restore tests (beta, 2.9.0): per site, DockNest restores the latest verified backup onto a test server you choose, starts it, runs checks (containers running and healthy, still running after 60 seconds, database checks, optional internal web check), records the result and removes everything it created. Off by default; daily, weekly or monthly. Limits for time, memory and CPU; no internet unless an administrator turns on **Allow internet** (mail ports, the metadata service and the test server's own addresses are blocked inside the copy). Testing on the site's own server is opt-in. Results: passed, failed, couldn't run, cancelled. New alerts: failed, couldn't run, passed again, needs you. Clean-up survives restarts. See [docs/restore-tests-guide.md](docs/restore-tests-guide.md) and [docs/restore-tests.md](docs/restore-tests.md).
- Storage report on the Storage page: space per site and per storage, growth over the last 30 days and a labelled best-case estimate of what incremental backups could save. New API: `GET /api/storage-report` (administrators). It reads metadata only.

### Changed

- Redesigned sign-in and first-run setup pages: a split screen with the DockNest logo and a calm animated backdrop, a monochrome look, a show/hide password button, and one short inline error ("Invalid password or code." never says which part was wrong).
- New Mauve ink colour palette in light and dark: neutrals carry a hint of the brand purple, better contrast for charts.
- Maintenance page: "Powered by DockNest" in the footer now links to the DockNest project on GitHub. It is part of the page and is always shown.
- License: a NOTICE file adds one AGPL-3.0 section 7(b) term: the "Powered by DockNest" credit and its link must be kept on visitor pages, including in modified versions.
- Database migration 9 adds restore test tables only; nothing existing changes, and releases before 2.9.0 keep working on it. Finish or cancel tests before rolling back. See [docs/upgrading.md](docs/upgrading.md) and [docs/security.md](docs/security.md).

### Fixed

- Map details panel: copy is now an icon on the right of each value, long values no longer get cut off, and the Alerts section matches the rest of the panel.

## [2.8.2] - 2026-10-24

See [docs/releases/2026-10-24-v2.8.2.md](docs/releases/2026-10-24-v2.8.2.md).

### Fixed

- Full ZIP download behind Cloudflare and other proxies: **Download ZIP** now opens a "Preparing your ZIP" window that checks the whole backup first (progress, percent and time left, "ready for 60 minutes"), then starts the download immediately, so no request sits silent long enough to be cut (error 524). The ZIP is still never stored on the server: the backup is read once to verify it and again while the ZIP streams to your computer, and the download fails visibly if the backup changed in between. Hard links inside a backup appear in the ZIP as small notes (the original archives keep them). New API: `POST/GET/DELETE /api/backups/:id/zip-exports` and `.../download`; the old `?format=zip` link keeps working for backups up to 500 MB. See [docs/backup-format.md](docs/backup-format.md) and [docs/security.md](docs/security.md).

## [2.8.1] - 2026-10-24

See [docs/releases/2026-10-24-v2.8.1.md](docs/releases/2026-10-24-v2.8.1.md).

### Fixed

- Full ZIP download: the ZIP is streamed to the browser instead of being saved on the server first, and the space check asks for the backup's size plus 2 GiB instead of eight times its size. A 11.5 GB backup on a server with 61 GB free was refused before; it now downloads. The backup is still fully authenticated before the first byte is sent, and the export stops cleanly if the server runs low on space.

## [2.8.0] - 2026-10-24

See [docs/releases/2026-10-24-v2.8.0.md](docs/releases/2026-10-24-v2.8.0.md).

### Added

- Map (2.8.0): solid lines that light up their whole path on hover or selection; nodes can be dragged by their body while you work (grid snap, Undo and Redo, Tidy up, smooth glide when the layout re-sorts, nothing saved); drag items from "+" onto the map; richer details with copy buttons.
- Alerts on the Map (2.8.0): Telegram and Email alert nodes, a DockNest source node and purple lines for rules. Drag from the small circle on a server, site or DockNest to an alert (or use "Send alerts to…" in its details), tick the events in a sheet, click a line to change or remove it. "+" adds Telegram or Email alerts; secrets are never shown again ("Saved" and Replace), saving needs re-verification, and "Send test message" shows the result in plain words. On phones the list has an Alerts section. Administrators only.
- Alerts engine (2.8.0, backend; the Map screens come separately): Telegram and email nodes that share sealed credentials (one bot or mail account can serve several nodes), each with a "send test message" button, and lines (rules) that choose which events reach them: backup failed or finished, a move finished or waiting for you, a server not answering or low on disk, and a new DockNest release. Messages are short and plain, retried up to 3 times and never repeated within 10 minutes. Credentials are sealed with the master key and never shown again. Email is always encrypted. See [docs/alerts.md](docs/alerts.md). Upgrade-safe: one new additive database migration (8) and nothing is sent until you add a channel.

## [2.7.0] - 2026-10-24

See [docs/releases/2026-10-24-v2.7.0.md](docs/releases/2026-10-24-v2.7.0.md).

### Added

- Moving a site: when the new server lacks nginx, Docker, Docker Compose 2 or certbot, an administrator can ask DockNest to install it (optional; confirmed with re-verification, with a "Show command" line to run it yourself). Supported on Debian and Ubuntu (apt) and Fedora, Rocky, AlmaLinux and RHEL (dnf) with the system's own packages only: no repositories added, no scripts downloaded, no configuration edited, nothing removed. Backend: `POST /api/servers/:id/install`, a fixed package list and argv in the remote helper, the `install` field on preflight checks, and a new additive `server_installs` table (schema v7). See docs/moving-sites.md and docs/security.md.
- Map v2: an n8n-style canvas with square nodes, ports and elbow lines, and a Backup storage column (free space, which sites back up there). The map always opens at regular size; Fit to screen shrinks it only when you ask.
- Map: click a server, site or storage node to open its details on the right (domains, containers, databases that move with the site, backup storage, last backup, tools on the server). "+" at the top right adds a server or backup storage; "+" beside a server lists the Docker projects and nginx sites found there that are not added yet, and opens the existing Add site wizard with that site chosen.
- Moving a site on the Map: pull the end of its line off the server (the site shows "Not connected" and Save changes stays off) and drop it on another server. Keyboard and phone have the same steps.

### Fixed

- Map: the map takes exactly the height left on the screen, so the whole map and the hint below it are visible without scrolling on any screen size.
- Map on phones: in "Move … to", a long reason a server cannot be used wraps inside its card instead of running off the screen, and the sheet opens with focus on its title, so Cancel no longer shows a focus ring on open and keeps clear of the iPhone home bar.
- Update button: a run that stopped before changing anything (for example a failed signature check, low disk space, or jobs still running) no longer uses up one of the 6 updates allowed per day. Before, a few such stops could block the button for the rest of the day. A separate limit of 24 attempts per day still applies. Takes effect after `sudo scripts/install-updater.sh --repair` on the host.
- Moving a site: every "cannot move here" reason is one short, plain sentence that says what to do, for example "phaseX needs nginx. Install it, then try again." instead of a longer technical one.

### Changed

- Release notes are short and written for dashboard users (New, Better, Fixed, Security, Before you update); testing details stay in the changelog and the release pull request. The pull request template asks for a one-line user-facing release note. The 2.6.0 notes use the new style.

## [2.6.0] - 2026-10-23

See [docs/releases/2026-10-23-v2.6.0.md](docs/releases/2026-10-23-v2.6.0.md).

### Added

- Map page (read-only): servers and their sites, arranged automatically, with pan, zoom, Fit to screen and a list view on phones. `npm run test:map` browser suite.
- Map move flow (administrators): drag a site to another server, Save changes, a plain "Ready to move" summary (advanced settings collapsed), simple progress with Cancel until the switch, then one DNS record to copy while DockNest waits for the domain. Operators see the map read-only. On phones, "Move to…" opens the same steps as full-screen sheets. The UI talks to `/api/moves` through `web/map/moves-client.js`.
- Site move engine: administrators can preview, start, follow and cancel moving a site to another server through `/api/moves` ([docs/moving-sites.md](docs/moving-sites.md)). DockNest takes a fresh verified backup, deploys and tests a copy on the new server (loopback only, outgoing mail blocked where the firewall allows), takes a final copy behind the maintenance page, waits for your DNS change and keeps the old copy stopped for 7 days. Ports taken on the new server move to the next free one; DockNest writes one nginx file of its own and never installs software, overwrites existing folders or deletes data. An estimated downtime over 30 minutes is a warning that needs "Move anyway" rather than a refusal. Real moves are validated only by the two-host Linux integration test.
- Moving a site, safety: a failure after the DNS switch never undoes the move (the new copy and its data are kept; Try again or Switch back), Cancel and go back while waiting for DNS, a 48-hour DNS wait limit, Cloudflare-proxied domains explained and confirmable, a slow step is stopped on the server before Try again, and cancel, continue and resolve need a recent re-verification. Moves refuse system and protected paths, Compose settings the backup does not hold and an existing Compose project of the same name; removing an old copy deletes only its own read-write data. Move jobs use statuses older releases ignore; finish or cancel moves before rolling back.
- Moving a site, continued: **Switch back** within the 7 days, **Remove old copy** (never automatic; keeps data folders unless "also delete the old data" is ticked), an optional Cloudflare token for automatic DNS switching (sealed, never shown again), Compose sites deployed through a generated Compose override, outgoing email from the test copy blocked through Docker's firewall chain where available (the preview says when it is not), step time limits that ask you to Try again or Undo, and the exact certbot command when the new server has no certificate account.

### Changed

- CI runs once per change (main pushes and pull requests), cancels superseded pull-request runs, and runs the Linux integration suite on main and on pull requests that are ready for review (skipped on drafts).

### Fixed

- Access: the users table splits Status and Role into their own columns, aligned like the other tables, and the Active status shows its proper icon.
- Storage card buttons now really share the full width of the card; an older layout rule still placed them in three fixed columns.

## [2.5.0] - 2026-10-23

See [docs/releases/2026-10-23-v2.5.0.md](docs/releases/2026-10-23-v2.5.0.md).

### Added

- Branded error pages in one shared style (a full-screen page with a large status code that fades out, one sentence and one button): 404 for unknown pages, 403 when an operator opens an administrator page, 401 when a session ends, and the 500 "This page stopped working" screen (Reload page and Open GitHub unchanged, same privacy behaviour).
- `public/unavailable.html`: a self-contained 503 page for reverse proxies that retries every 10 seconds. The bundled Caddy profile serves it automatically; `docs/deployment.md` shows nginx and Caddy setups.
- `npm run test:status-pages` browser suite.

### Fixed

- Upgrades keep the previous release's image. `scripts/upgrade.sh` tags it `<repository>:pre-upgrade` before it builds or pulls and `<repository>:previous` (`docknest:previous` from source) after a success, so `docker compose build` re-tagging `docknest:local` no longer leaves it without a name, where Docker's containerd image store could drop it and the printed rollback (`docker tag sha256:… docknest:local`) failed with "No such image". The rollback hint now uses the tag. The installed release's script runs an upgrade, so this takes effect from the upgrade after the one that installs it; before upgrading from 2.4.1 or earlier, run `docker tag docknest:local docknest:previous` to keep that release's image ([docs/upgrading.md](docs/upgrading.md#what-is-removed-after-an-upgrade)).

### Changed

- Unknown non-API paths now answer with status 404 and the app, which shows its 404 page. API 404s remain JSON.

- Storage card buttons share the full width of the card, so a card with two buttons has no empty space beside them.
- Retention after a successful upgrade keeps exactly the running and the previous DockNest image and removes every other image of the installation's repository that no container uses (including legacy tags such as `docknest:sqlite-online`), its recorded untagged images, and untagged images with the new Dockerfile label `io.github.dahanitamar.docknest` (old releases and build stages). Never `--force`, never a prune command, never another repository.
- The upgrade ends with a `Cleaned up: N old DockNest images` line, also written to the status file as the additive `cleanup` field (accepted by the host updater and the API transport). From source it also prints the optional, host-wide `docker builder prune --filter until=168h`; the script does not trim the build cache itself because Docker cannot scope it to one project.

### Security

- Sign-in, code, invitation and other API rate limits now key an IPv6 client by its /64 prefix (and an IPv4-mapped address, dotted or hex, as plain IPv4). This includes the public update progress limiter. Before, rotating addresses inside one ordinary IPv6 allocation gave a fresh budget on every request. IPv4 limits are unchanged; existing counters for IPv4-mapped clients start again once after the upgrade.
- Only administrators can add or change a site's configuration files, Compose files, website files folder, staging directory or maintenance directory. Operators get HTTP 403 (`ADMIN_REQUIRED`) unless discovery reports the path for that server; saved paths keep working for backups, restores and downloads. Before, an operator could add any file on a source server (for example `/etc/shadow`) to a backup and download it decrypted.
- The remote helper never captures `/etc/shadow`, `/etc/gshadow`, `/etc/sudoers*`, SSH host keys (`/etc/ssh/*_key`), SSH key folders, `/proc`, `/sys` or `/dev`, or a folder that contains them. Paths are checked as written (a leading `//` counts as `/`) and after following symlinks. The API refuses paths starting with `//`, and staging directories inside system folders such as `/etc`, `/root` or `/usr/bin`. It deploys a maintenance page only under the staging root, the site's project folders or a web root (`/var/www`, `/srv`, `/usr/share/nginx`); an existing deployment elsewhere keeps working, with a warning, unless the folder is a symlink into a system folder.
- Restore extraction follows each archive symlink through the archive's other symlinks before extracting, so a chain of links that each stay inside (for example `d -> ../..` and `l -> d/../..`) can no longer point outside the restore directory. Absolute link targets are refused as before, and link loops are now refused too.
- Restore extraction is refused before anything is written when the archive's declared file sizes do not fit in the free space of the target filesystem (64 MiB reserve).
- A capture time reported by the source server outside the job's own run (10 minutes tolerance) is replaced by the DockNest server time. A reset or future source clock could otherwise make retention delete the newest recovery point right after it was published. The job shows a "Source server clock" warning and the manifest records `sourceClock`.
- The helper no longer follows symbolic links in the maintenance directory: the `enabled` flag refuses a link, a FIFO or any other non-regular file and is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and the maintenance page is written through a unique `O_EXCL` temporary file. Before, anything that could write that directory could make the root helper change the mode of, or overwrite, a host file.
- Restoring a recovery kit revokes enrollment invitations that were still open in the snapshot.
- Since 2.1.0, every successful site backup was wrongly treated as superseded after publishing. It skipped the source staging cleanup, so the plaintext package stayed on the source server under its staging directory, and it also skipped retention, the `backup.completed` audit event and the job's warnings. Backups now complete inside the publication transaction, and cleanup and retention run again. A job taken over by another worker keeps `recovery_required`. Upgraded installs clean up the old leftovers automatically with the first successful backup of each site after the upgrade, in the site's own staging root (default `/var/lib/docknest`). The helper only lists the folders whose name is exactly a job ID and that are real directories; links are never followed. DockNest then removes a folder through the existing `cleanup` operation, which requires the `disarmed` and `watchdog.done` markers, only when its database shows that job as completed, or does not know the job at all and the folder is older than 6 hours. Folders of queued, running, recovery-required or failed jobs, `maintenance` and every other name stay. Only the count and the freed size are recorded, as the `staging.swept` audit event. The same backup also applies retention to the site's older points. Startup reconciliation after a crash no longer turns a `recovery_required` job into `completed`, so the per-server block stays until recovery is reviewed. When reconciliation completes a job that was still running, it also runs that job's source cleanup and retention.
- Host updater: an in-app upgrade of an install that runs an image the broker does not recognise as `ghcr.io/dahanitamar/docknest:<version>` (a mirror, or no tag) is now refused (`state-mismatch`, nothing changed) instead of pulling that image by its tag without verifying it. Such installs upgrade from the command line.
- Host updater: on start, the broker reads its last published `status.json` back through the `status/` directory descriptor without following links (a root-owned regular file only), so a planted link or forged file in the volume cannot turn an interrupted run into a success and lift the block.
- CI: every action in the Verify workflow (`ci.yml`), whose result the release gate trusts, is pinned to a full commit SHA like the release workflows, and no checkout keeps the job token in `.git/config` (`persist-credentials: false`).
- Dependencies: Vite 7.3.7 (development server only; fixes GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22 and the bundled `launch-editor` advisories). `npm audit` reports no known vulnerabilities.

## [2.4.1] - 2026-10-23

See [docs/releases/2026-10-23-v2.4.1.md](docs/releases/2026-10-23-v2.4.1.md).

### Added

- Readable Audit trail: action labels, display names for actors (System, Worker, Scheduler, Unknown user fallbacks), proportional columns, **View details** as an icon button with the raw code inside.
- "What happened?" prefill for job, storage, server and DockNest backup reports from a static catalogue of DockNest's own fixed messages (`web/report/catalogue-data.js`), or from an opt-in, redacted, editable **Include the error message** text.
- The GitHub mark on every **Open GitHub** button.
- Host updater: a rate-limited refusal names the limit (`cooldown` or `daily`) and the earliest time a new run is allowed (`limit`, `retryAt`); the limits themselves are unchanged.
- API (additive): `GET /api/state` gains `actors` (names only for accounts in the returned audit rows); a rate-limited update request returns `limit` and `retryAt`; the progress limiter's 429 returns `retryAfter`.
- `npm run test:layout` browser suite, and a shared count helper (`web/plural.js`).

### Changed

- Wide screens (1920 px and up): 40 px edge (48 px from 2560 px), content up to 2200 px at 2560 px and 3400 px at 3840 px, with the sidebar expanded or collapsed.
- Audit and Jobs size to the viewport (at least 10 rows).
- The header search box is removed; each list page has a funnel filter with the record count.
- Collapsed sidebar rail: a 44 px health pulse and a 44 px capacity ring only, no frame at rest, focus ring on keyboard focus only.
- Sidebar storage readout and rail popover name the destination; the Storage page shows four destinations per page, fitted to the screen.
- Overview metrics: a 3 x 2 grid from 1024 px; Recovery points opens on Month.

### Fixed

- The pager gap differed between full and partial pages; card pages keep a 24 px gap on every page and width, phones included.
- "1 successful backups" and other count plurals.
- The updater rate-limit message said "wait a few minutes" for the daily limit; it now names the limit and the time. The API's own 429 says how many seconds to wait.
- Truncated Audit cells.

## [2.4.0] - 2026-10-23

See [docs/releases/2026-10-23-v2.4.0.md](docs/releases/2026-10-23-v2.4.0.md).

### Added

- Problem reports across DockNest: an **Open GitHub** button in the red failure panels of job details, storage and server connection tests and DockNest backup, on the update result screen and on failed Recent updates rows opens a "Review what will be shared" dialog, then a pre-filled public GitHub issue in a new tab. Typed, allow-listed values only; the server sends nothing (docs/security.md, Problem reports).
- App error boundary: "This page stopped working" with Reload page and a report that carries only the page, area and error name.
- Update-failure reports with the section 7.1 fields, an environment section (on by default, untickable) and an optional redacted error excerpt (off by default).
- Issue forms job-failure.yml, storage-failure.yml, server-connection.yml, self-backup-failure.yml, app-error.yml and update-failure.yml.
- API (additive): storage tests return `errorClass` and server connection tests `check` and `errorClass` next to the unchanged message; the admin update status adds typed report fields; `GET /api/updates/requests/:id` returns one past request's admin status.
- `npm run test:reports` browser suite, run in CI.

### Changed

- Settings > About: the button is now labelled **Report a bug** and uses the shared review dialog.

### Removed

- The duplicate `bug_report.yml` issue form (it asked for logs); `bug-report.yml` remains.

## [2.3.1] - 2026-10-23

See [docs/releases/2026-10-23-v2.3.1.md](docs/releases/2026-10-23-v2.3.1.md).

## [2.3.0] - 2026-10-22

See [docs/releases/2026-10-22-v2.3.0.md](docs/releases/2026-10-22-v2.3.0.md).

### Changed

- Site-wide interface redesign: one type scale, layout tokens for phone to 4K, plain status labels with an icon instead of pills, frameless icon buttons, red alert panels for blocked and failed states, and shared card and table styles (web/system.css).
- README no longer carries hand-written version numbers; the badge and the latest-release link show the current version.

## [2.2.2] - 2026-10-22

See [docs/releases/2026-10-22-v2.2.2.md](docs/releases/2026-10-22-v2.2.2.md).

## [2.2.1] - 2026-10-22

See [docs/releases/2026-10-22-v2.2.1.md](docs/releases/2026-10-22-v2.2.1.md).

## [2.2.0] - 2026-10-22

See [docs/releases/2026-10-22-v2.2.0.md](docs/releases/2026-10-22-v2.2.0.md), including the upgrade notes.

Planned as 2.2.0 (the version bump belongs to the release pull request). Draft notes: [docs/releases/2026-10-22-v2.2.0.md](docs/releases/2026-10-22-v2.2.0.md). Not yet validated on a Linux Docker host.

### Added

- Update Center for administrators: an opt-in update check (answered once; with yes, the worker checks the GitHub release list daily and administrators can check on demand; nothing is sent before the answer), upgrade requests confirmed with the password and an authenticator code (`POST /api/updates/requests`), history, and an update lock that answers `423 UPDATE_IN_PROGRESS` to everything but a short list of routes while an update runs. Public `GET /api/updates/progress` returns only phase, target, state and timestamps. Metadata migration 5 (`update-center`, compatible) adds the tables.
- Report a bug (Settings > About): a pre-filled public GitHub issue built in the browser from the version and install mode only; the server sends nothing.
- `TRUST_PROXY` (optional, unset by default): the exact address or CIDR of the reverse proxy whose `X-Forwarded-For` DockNest may trust. Without it no proxy is trusted.
- Optional host updater: `sudo scripts/install-updater.sh` (also `--status`, `--ack`, `--repair`, `--uninstall`) installs a root socket service that verifies a signed release and runs `scripts/upgrade.sh`. It refuses rootless Docker, Docker Desktop and a second install. New `docknest_updater` volume, mounted read-only in the `api` container.
- `scripts/upgrade.sh` flags: `--no-prune`, `--no-verify`, `--capabilities`, and for the host updater `--no-fetch`, `--expect-commit`, `--expect-image-digest`, `--upgrade-only`, `--request-id`. The status file gains `warning`, `reason`, `schemaFrom`, `schemaTo` and `requestId`.
- `docknest-release.json` names the tag, commit, repository and pre-release flag, optional highlights from the release notes front matter, and the updater file hashes; it is signed and the release workflow verifies the signature before publishing.
- `scripts/recovery-kit.js restore --ignore-updater` for disaster recovery.

### Changed

- `scripts/upgrade.sh` requires the target tag to be on `origin/main` and, for 2.2.0 and later, verifies the signed release manifest (needs `curl` and `cosign`; `--no-verify` skips both).
- After a successful upgrade the script keeps the newest 5 upgrade backups, the newest 2 `pre-downgrade-*` and `pre-rollback-*` copies and removes only old images this installation recorded. Runs that failed or were interrupted are kept. Earlier releases never deleted these automatically. `--no-prune` disables it.
- A failed health check after only compatible migrations now restores the previous release automatically (exit 4, no data discarded) instead of exit 5, and the image built for the failed target is removed.
- One `upgrade.sh` run at a time, through `data/.upgrade.lock`.

- No public release candidates. The release workflow refuses any tag with a pre-release suffix (`vX.Y.Z-rc.N`) before it builds anything, so GitHub Releases and image tags show final releases only. A candidate is the release merge commit on `main`: the `Release validation` workflow, run from `main` with that commit as `candidate`, validates it privately (built inside the runner, nothing pushed or tagged). A final `vX.Y.Z` tag is published only when its commit has a successful `Verify` run and a successful candidate validation. The workflow no longer runs on pushed tags; re-validating an existing release such as `v2.1.0` stays available by hand. See the release order in [docs/release-validation.md](docs/release-validation.md#release-order).

### Fixed

- The deployment hold waits for a queued or running DockNest self-backup before an upgrade proceeds.
- A recovery kit taken during a deployment hold no longer restores a manager that refuses all work: export is refused while the hold is on, restore clears it, and restore refuses while the host updater reports a running update.

## [2.1.0] - 2026-10-22

Release notes: [docs/releases/2026-10-22-v2.1.md](docs/releases/2026-10-22-v2.1.md), including the upgrade notes. 2.1.0 has the same application code as the pre-release 2.1.0-rc.1 (listed below; `src/` and `web/` unchanged), which passed the real upgrade validation from 2.0.0 on a Linux Docker runner (install, upgrade as documented, worker drain, downgrade to 2.0.0 and upgrade again with `scripts/upgrade.sh`). The v2.1.0 tag itself also passed Release validation. The entries below were first listed under 2.1.0-rc.1 and apply to 2.1.0.

## [2.1.0-rc.1] - 2026-10-22

Pre-release of 2.1.0, tagged `v2.1.0-rc.1`. The GitHub release for it has been removed (the tag remains); the current release is 2.1.0. Its changes:

### Added

- Versioned metadata migrations tracked in `PRAGMA user_version`. Before migrating, DockNest writes a private snapshot to `DATA_DIR/upgrade-snapshots` and keeps the newest five. Startup is refused on a newer schema, with rollback instructions.
- `scripts/upgrade.sh`: a one-command upgrade, rollback and downgrade with a deployment hold, configuration backup, health wait, automatic return when the schema is unchanged, and JSON progress for unattended runs.
- Public `GET /api/version` endpoint (`{version, schemaVersion}`). The preferences drawer shows the running version and links to the releases page. There is no automatic update check.
- Boot recovery reports `bootRecoveryOutdated` when the helper copied onto a host differs from the running release.
- Signed container images on GitHub Container Registry (`ghcr.io/dahanitamar/docknest`) and a `docknest-release.json` manifest on each release. Release notes are bundled in the image.
- `compose.override.yaml` (ignored by git) for local Compose changes, with an example file.
- Paginated history API.
- Worker lease and graceful drain when the worker is stopped.
- Recovery verification levels.
- S3-compatible backup storage.
- `Release validation` workflow (informational): upgrades a real v2.0.0 Compose installation to a release tag, drains the worker, then downgrades and upgrades again with `scripts/upgrade.sh`, checking data, configuration and secrets. See [docs/release-validation.md](docs/release-validation.md).

### Changed

- Hardened website probe URL validation: resolve once on the source server, refuse metadata, link-local and other internal addresses, pin connections, restrict redirects and apply one total time limit per probe. Sites whose stored URL is refused keep backing up with the probe skipped and a warning.
- Backup status labels describe what was actually checked instead of a single "Verified" label.
- Status marks use the shared icon set instead of text characters.

### Fixed

- A worker killed during a job no longer blocks its replacement after restart.
- Concurrent first start of the API and worker no longer fails with "database is locked".
- Flaky SFTP test fixtures caused by an ssh2 key-generation bug.

## [2.0.0] - 2026-10-17

### Added

- Online integrity checks for large SQLite databases, per-site `sqliteIntegrityCheck`, and reuse of unchanged-database checks.
- Delivery modes per site: a temporary copy then upload, or a direct stream to backup storage.
- Live job progress, step diagnostics and clearer failure causes.

### Changed

- SSH and storage sessions tolerate about 100 seconds of silence.

See [docs/releases/2026-10-17-v2.0.md](docs/releases/2026-10-17-v2.0.md) for the full notes.

[Unreleased]: https://github.com/DahanItamar/DockNest/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/DahanItamar/DockNest/compare/v2.0.0...v2.1.0
[2.1.0-rc.1]: https://github.com/DahanItamar/DockNest/compare/v2.0.0...v2.1.0-rc.1
[2.0.0]: https://github.com/DahanItamar/DockNest/releases/tag/v2.0.0
