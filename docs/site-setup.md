# Site setup

Choose **Add site**, select the source server, and search by domain, project or container. Discovery includes stopped Docker services and static nginx websites with an `index.html` document root. Docker project labels suggest membership; review all services and shared data before saving.

## Docker websites

Published web ports suggest the internal health URL. nginx proxy routes suggest domains. Enter a public page returning HTTP 200: a redirecting homepage may need `/login`. Keep this separate from the internal application health endpoint. Existing saved URLs remain unchanged when editing.

Compose files and their `.env` / `env_file` references are detected inside the project's directories. Safe links within those directories are resolved to regular files; file contents are never returned to the browser. Review additional dependencies and configuration files that discovery cannot infer. PostgreSQL/MySQL profiles require matching clean-shutdown evidence; Generic requires an explicit application review and zero exit codes during actual capture.

Temporary RAM folders (`tmpfs`) are listed in the wizard for information. Docker empties them on every container restart, so a backup has nothing to capture there and a restore recreates them empty with their original size, mode and flags. Database and uploaded content must be in persistent mounts. A RAM folder at an unusual path, or with mount options DockNest does not recognize, stops the backup with a message naming the container and folder.

Connect **Storage** and use **Check readiness**.

**Maintenance page (optional).** While a Docker site's containers are stopped for a backup, visitors can see a friendly "back in a minute" page instead of an error. When you add a site, **Show a maintenance page during backups** is ticked. For an existing site, use **Set up maintenance page** on its card (administrators only). DockNest then:

1. copies the page from **Maintenance** to the server,
2. writes its own file `/etc/nginx/docknest/<site id>.conf` and adds one `include` line after `server_name` in each nginx server block that serves the site's domain (blocks that only redirect are left alone),
3. runs `nginx -t` and reloads nginx,
4. switches the page on, checks that your domain answers with the maintenance page, switches it off, and checks that the site answers normally,
5. only then marks the site ready.

If any step fails, DockNest puts every file back and reloads nginx. The site is still added and its backups still run without the page. Automatic setup needs nginx running on the server itself. For Caddy, Traefik, Nginx Proxy Manager or nginx inside a container, integrate the page by hand; without it, backups still work. Readiness reads configuration, health, proxy markers and storage metadata; it does not stop services or prove a real backup/restore. Docker capture still verifies clean stopping, maintenance activation, recovery and encrypted transfer. Unsupported devices, external volumes, shared writers, escaping links and privileged configurations remain blocked. Saved Compose files need review before a separate production cutover.

## Static nginx websites

Select the detected domain to include its website directory and nginx virtual-host file. Confirm that deployments will not change the files during capture. nginx keeps serving visitors; no containers or daemons are stopped and no maintenance proxy is needed. Capture checks file contents, paths, modes and ownership against the source and its copied archive. Links, special files and roots outside detected static sites are rejected.

Encrypted storage, schedules, retention, ZIP downloads and restore jobs work through the existing pipeline. Static public HTTP probes are informational because a CDN can reject the source server while its files remain readable. A failed probe is reported explicitly; file/configuration and storage checks remain required. A static restore extracts into a new private directory and verifies its file digest. It leaves the live document root and nginx unchanged. Review the restored files before an explicit cutover. TLS keys, DNS, external services and dynamic PHP applications are not included in this static adapter.

Linux verification on 2026-10-02 covered real encrypted Docker and native static backup/restore in isolated fixtures. Site-specific operational findings are retained privately rather than in source control. Readiness remains separate from actual recovery validation.
