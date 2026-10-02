# Site setup

Choose **Add site**, select the source server, and search by domain, project or container. Discovery includes stopped Docker services and static nginx websites with an `index.html` document root. Docker project labels suggest membership; review all services and shared data before saving.

## Docker websites

Published web ports suggest the internal health URL. nginx proxy routes suggest domains. Enter a public page returning HTTP 200: a redirecting homepage may need `/login`. Keep this separate from the internal application health endpoint. Existing saved URLs remain unchanged when editing.

Compose files and their `.env` / `env_file` references are detected inside the project's directories. Safe links within those directories are resolved to regular files; file contents are never returned to the browser. Review additional dependencies and configuration files that discovery cannot infer. PostgreSQL/MySQL profiles require matching clean-shutdown evidence; Generic requires an explicit application review and zero exit codes during actual capture.

Review detected temporary RAM folders. `/tmp`, MySQL runtime directories, `/var/cache/nginx` and `/app/.next/cache` may be explicitly recreated empty on restore. Database and uploaded content must be persistent. Other RAM paths require an adapter rather than silently losing data.

Connect **Storage**, deploy the maintenance page, integrate the source proxy, and use **Check readiness**. Readiness reads configuration, health, proxy markers and storage metadata; it does not stop services or prove a real backup/restore. Docker capture still verifies clean stopping, maintenance activation, recovery and encrypted transfer. Unsupported devices, external volumes, shared writers, escaping links and privileged configurations remain blocked. Saved Compose files need review before a separate production cutover.

## Static nginx websites

Select the detected domain to include its website directory and nginx virtual-host file. Confirm that deployments will not change the files during capture. nginx keeps serving visitors; no containers or daemons are stopped and no maintenance proxy is needed. Capture checks file contents, paths, modes and ownership against the source and its copied archive. Links, special files and roots outside detected static sites are rejected.

Encrypted storage, schedules, retention, ZIP downloads and restore jobs work through the existing pipeline. A static restore extracts into a new private directory and verifies its file digest. It leaves the live document root and nginx unchanged. Review the restored files before an explicit cutover. TLS keys, DNS, external services and dynamic PHP applications are not included in this static adapter.

Current operational check, 2026-10-02: DemoBlog, DemoShop and Leads passed read-only readiness. Leads' health endpoint is port 3200 `/api/health`, its public readiness page is `/login`, and its environment file is `.env.production` (`.env` is a link to the same file). Its maintenance routing was verified with brief 503 responses and restored 200 responses without stopping containers. demo.example.invalid uses nginx static hosting, not Docker. Full Linux fixtures validated both Docker and native static encrypted backup/restore; this does not claim a new production Docker backup for every site.
