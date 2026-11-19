# App setup

Choose **Add app**, select the source server, and search by domain, project or container. Discovery includes stopped Docker services and static nginx websites with an `index.html` document root. Docker project labels suggest membership; review all services and shared data before saving.

**Containers that are already backed up.** Discovery hides containers that another app on the same server already backs up, so the same container is not captured twice. When only part of a Compose project is covered, the project is still listed with just its free services, and a note says that the other services belong to an existing app. When every discovered container is already covered, the dialog says so instead of listing anything. If a request would still back up a container that belongs to another app (for example through the API or a stale dialog), the server refuses it with a message that names that app. To change which app owns a container, edit or remove the existing app first.

## Docker websites

Published web ports suggest the internal health URL. nginx proxy routes suggest domains. Enter a public page returning HTTP 200: a redirecting homepage may need `/login`. Keep this separate from the internal application health endpoint. Existing saved URLs remain unchanged when editing.

Compose files and their `.env` / `env_file` references are detected inside the project's directories. Safe links within those directories are resolved to regular files; file contents are never returned to the browser. Review additional dependencies and configuration files that discovery cannot infer. PostgreSQL/MySQL profiles require matching clean-shutdown evidence; Generic requires an explicit application review and zero exit codes during actual capture.

Temporary RAM folders (`tmpfs`) are listed in the wizard for information. Docker empties them on every container restart, so a backup has nothing to capture there and a restore recreates them empty with their original size, mode and flags. Database and uploaded content must be in persistent mounts. A RAM folder at an unusual path, or with mount options DockNest does not recognize, stops the backup with a message naming the container and folder.

Connect **Storage** and use **Check readiness**.

**Maintenance page (optional).** While a Docker app's containers are stopped for a backup, visitors can see a friendly "back in a minute" page instead of an error. When you add an app, **Show a maintenance page during backups** is ticked. For an existing app, run **Check readiness** and choose **Set up maintenance page** next to the maintenance check (administrators only). DockNest then:

1. copies the page from **Maintenance** to the server,
2. writes its own file `/etc/nginx/docknest/<site id>.conf` and adds one `include` line after `server_name` in each nginx server block that serves the app's domain (blocks that only redirect are left alone),
3. runs `nginx -t` and reloads nginx,
4. switches the page on, checks that your domain answers with the maintenance page, switches it off, and checks that the app answers normally,
5. only then marks the app ready.

If any step fails, DockNest puts every file back and reloads nginx. The app is still added and its backups still run without the page. Automatic setup needs nginx running on the server itself. For Caddy, Traefik, Nginx Proxy Manager or nginx inside a container, integrate the page by hand; without it, backups still work. Readiness reads configuration, health, proxy markers and storage metadata; it does not stop services or prove a real backup/restore. Docker capture still verifies clean stopping, maintenance activation, recovery and encrypted transfer. Unsupported devices, external volumes, shared writers, escaping links and privileged configurations remain blocked. Saved Compose files need review before a separate production cutover.

## Coverage

`GET /api/servers/:id/coverage` (any signed-in role) scans the server on demand and lists every container and volume
with its status: `backed-up` (its app has a verified backup), `pending` (its app has none yet), `not-backed-up` or
`skipped` (marked on purpose, with an optional note of up to 200 characters). A volume belongs to the app whose
container mounts it. DockNest's own restore copies, restore test copies, Safe Edit holders and move test copies are
left out. `complete` is `false`, with a line in `problems`, when volumes could not be listed or a container could not
be read; such a scan is never all clear. Mark or unmark an item with `PUT /api/servers/:id/coverage/ignores`
`{"kind":"container"|"volume","name":"...","note":"..."}` and `DELETE /api/servers/:id/coverage/ignores/:kind/:name`;
both are audited without the note. See [the design](coverage-and-restore-check.md).

## Static nginx websites

Select the detected domain to include its website directory and nginx virtual-host file. Confirm that deployments will not change the files during capture. nginx keeps serving visitors; no containers or daemons are stopped and no maintenance proxy is needed. Capture checks file contents, paths, modes and ownership against the source and its copied archive. Links, special files and roots outside detected static sites are rejected.

Encrypted storage, schedules, retention, ZIP downloads and restore jobs work through the existing pipeline. Static public HTTP probes are informational because a CDN can reject the source server while its files remain readable. A failed probe is reported explicitly; file/configuration and storage checks remain required. A static restore extracts into a new private directory and verifies its file digest. It leaves the live document root and nginx unchanged. Review the restored files before an explicit cutover. TLS keys, DNS, external services and dynamic PHP applications are not included in this static adapter.

Linux verification on 2026-10-02 covered real encrypted Docker and native static backup/restore in isolated fixtures. App-specific operational findings are retained privately rather than in source control. Readiness remains separate from actual recovery validation.
