# Authentication and access

The system uses one shared system password plus a separate authenticator identity for each authorized person. Login asks for the shared password and a six-digit TOTP code together, or an unused personal recovery code. The second factor identifies the person's account and role. Knowing the shared password alone does not grant access.

## Enrollment and account lifetime

The first administrator is provisioned through the local PowerShell setup command. It prompts for the selected password, opens a temporary local QR/recovery page, and requires a valid authenticator code before activating the administrator. The QR file is deleted after confirmation. The web login only shows Password and 2FA code. The legacy API setup route still requires the local setup token; it cannot expose a pending administrator authenticator with the shared password alone. Administrators create named operator invitations in Access management. An invitation expires after 15 minutes and can be used once. Its enrollment URL places the opaque token in a browser fragment; the browser submits it only to the enrollment endpoints.

The invited person opens the link, enters the shared password, scans the locally generated authenticator QR, and confirms a code. Password verification produces a short-lived enrollment proof required for confirmation. An account awaiting enrollment cannot log in. Save the resulting personal recovery codes privately; each works once. The administrator distributes the invitation and shared password through their chosen private channels: this application does not send email invitations automatically.

The 15-minute expiry applies to enrollment, not to the account or authenticator. An enrolled account remains authorized until revoked. Regenerating an invitation invalidates the earlier link. Resetting an active operator’s authenticator requires confirming their name and signs them out; they must complete the new invitation before logging in again. Administrators cannot revoke or reset administrator accounts through these operator controls. Treat QR images, authenticator secrets, invitation links, and recovery codes as credentials; do not publish them.

## Permissions and revocation

Administrators manage invitations, revoke access, and rotate the system password. Operators cannot use those administrator routes. Removing a person immediately disables their account and invalidates their sessions. Neither the shared password nor their previous authenticator/recovery codes can reactivate a disabled account.

Sensitive administration requires password plus that administrator's personal factor verified within the previous five minutes. The server returns REAUTH_REQUIRED when another verification is needed. Rotating the shared password signs everyone out and invalidates pending login/enrollment challenges and invitations. Tell authorized people the replacement password privately.

### Roles and site host paths

Some site settings name folders and files on the source server that the helper reads or writes as root. Only administrators can add or change them. An operator who saves a site with a new or changed path gets HTTP 403 (`ADMIN_REQUIRED`) and the message "Only an administrator can change the ... of a site". Operators can still edit every other field, remove paths, and run backups, restores and downloads that use paths an administrator saved.

| Site setting | Administrator | Operator |
| --- | --- | --- |
| Configuration (environment) files | Any path except protected system paths | Saved paths, or paths discovery reports for that server |
| Compose project files | Any path except protected system paths | Saved paths, or paths discovery reports for that server |
| Static website files folder | A folder discovery reports | Saved folder, or a folder discovery reports |
| Staging directory | Outside system folders (`/etc`, `/root`, `/usr/bin` and the others the helper refuses) | Saved value or the default `/var/lib/docknest` only |
| Maintenance directory | Under the staging root, a project folder or a web root | Saved value or the default under the staging root only |
| Name, containers, services, schedule, probe URLs, domains | Yes | Yes |

Moving a site to another server checks all of its paths again. When discovery cannot reach the server, a path counts as not discovered.

The helper also checks paths, for every role. It never captures `/etc/shadow`, `/etc/gshadow`, `/etc/sudoers*`, the SSH host keys (`/etc/ssh/*_key`), `/root/.ssh`, any `.ssh` folder, `/proc`, `/sys` or `/dev`, nor a folder that contains one of them (such as `/etc/ssh` or `/`). Each path is checked as written, with a leading `//` read as `/`, and again after following symlinks, so a link such as `/opt/x -> /etc` does not get around the list. The API also refuses paths that start with `//`. It deploys a maintenance page only under the site's staging root, its Compose project folders, its website folder, `/var/lib/docknest`, `/var/www`, `/srv` or `/usr/share/nginx`, and never inside system folders such as `/etc`, `/root` or `/usr/bin`. A maintenance directory outside these places that is already deployed (it already holds `maintenance.html`) or already integrated (it holds `ready`) keeps working. The helper reports a warning, and the API logs it as `Remote helper warning:`. The exception is a maintenance folder that is a symlink into a system folder (for example `/var/www/x -> /etc/cron.d`). The helper refuses to deploy into it or to enable maintenance there, but it still lets the site leave maintenance. To clear the warning, move the folder under `/var/www/<domain>` or the staging root and update the site.

Upgrading: a site that already lists a protected path stops backing up with "Protected system path refused" until an administrator removes that path. A site whose staging directory is inside a system folder keeps backing up, but it can be saved again only after its staging directory is moved, for example to `/var/lib/docknest`. No other saved site changes behaviour.

## Session expiry

The server rejects sessions after 30 minutes without reported user interaction and after eight hours from login, even with continued activity. Dashboard polling and ordinary reads do not renew the idle timer. The UI reports trusted keyboard/pointer interaction through the protected activity endpoint; that endpoint cannot revive an expired session.

These limits are checked on the server, independently of browser countdowns. A client possessing a session can submit activity reports, so the idle timer is not proof a human remains present. Logout invalidates the session immediately. HTTPS deployments use Secure, HttpOnly, SameSite=Strict cookies and CSRF/origin checks.

Server-side idle and absolute expiry follow the principles in [OWASP's Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#automatic-session-expiration). The configured 30-minute/eight-hour limits are this project's choices.

## Secret handling and migration

Password hashes use the project's password-hashing routine. Authenticator and SSH secrets remain encrypted using the external master key; invitation/session/challenge tokens are stored as hashes. TOTP replay counters and one-use recovery hashes prevent successful factor replay. Ambiguous factor matches fail closed rather than selecting an arbitrary identity.

Existing installations migrate the earliest account to administrator and preserve its password as the shared system password. Keep a protected state/key backup before upgrades. Shared passwords have operational tradeoffs: rotate when membership changes, retain personal-factor separation, and review the per-person audit trail.

Run `npm run check` for regression checks. Verify HTTPS, browser interaction/idle logout, authenticators, and revoke behavior on the actual deployment before granting access.

New shared passwords must be 4-16 characters, including numeric passwords. Login still accepts previously configured longer passwords so the policy change does not lock out existing users. Password-only login never grants a session. Every private API route requires an enabled, enrolled account and a valid session; API data responses are never cached. Login/enrollment screens and static frontend assets remain public. Short passwords reduce resistance to guessing; mandatory personal MFA, rate limits, replay checks, and session revocation remain enforced.

## Health and maintenance probe URLs (SSRF)

Each site stores an application health URL and a public maintenance URL. The remote helper fetches them as root on the source server during readiness checks, maintenance activation and release, watchdog and boot recovery, and post-backup verification. Operators, not only administrators, can create and edit sites. Without limits, a probe URL could make the source server request cloud metadata (`169.254.169.254`, `fd00:ec2::254`), link-local or private services, either directly or through an HTTP redirect.

The helper makes the authoritative decision, because names resolve on the source server:

- It resolves the host once per request and connects only to the validated addresses, with no second DNS lookup. A domain cannot pass the check and then rebind to another address. TLS still verifies the original hostname.
- Every resolved address must pass. Link-local, cloud metadata, multicast, unspecified, reserved and `0.0.0.0/8` addresses are always refused.
- Loopback (`127.0.0.0/8`, `::1`) and public addresses are allowed. This covers published container ports such as `http://127.0.0.1:8080/`, a site domain mapped to `127.0.0.1` in `/etc/hosts`, and a domain that resolves to the server's own public IP.
- Private, CGNAT and ULA addresses are allowed only when the URL host is one of the site's configured domains and the address belongs to the source server itself (the helper checks this by binding to it). Private IP literals, such as a container's bridge IP, are refused. Use the published loopback port or the site domain instead.
- Redirects are followed for at most five hops, and each hop is validated and pinned again. A redirect is followed only when all of these hold:
  - It goes to the same host or to another configured site domain.
  - It keeps the scheme, or upgrades HTTP to HTTPS.
  - It keeps the port, or moves to the default port, either on an upgrade or for a configured domain.

  Any other redirect is not followed, and the probe fails because the redirect status is not the expected result. A redirect target the address policy refuses, or one with login details or a non-HTTP scheme, also fails the probe. It is never treated as a skipped probe. Only a refused stored URL is skipped.
- Each probe has one total time limit: 5 s for health and 10 s for public probes. The limit covers every connection attempt, every redirect and the body read, so a server that sends data slowly cannot extend it. A probe that runs out of time counts as failed. Responses are still read only up to 256 KB. The origin-probe mode still connects only to `127.0.0.1` with the original Host header and TLS name.

The API checks these URLs earlier as well. Health URLs, maintenance URLs and the default public URL built from the first domain are refused when they contain an IP literal in a metadata, link-local, private, CGNAT, ULA, multicast, unspecified or reserved range. HTTP(S) is still required, and login details in the URL are still rejected. The API cannot resolve names the way the source server does, so the helper check remains authoritative.

A probe URL the policy refuses never stops a backup, and its target is never contacted. Before anything changes on the host, a capture resolves each probe URL it will use. This sends DNS queries only, no HTTP request. Refused probes are turned off for the whole job: the maintenance enable and release probes, the restart health check, the recovery watchdog and boot recovery (which read the same journaled settings), and post-backup verification. Health then relies on container state and Docker health checks, the same as for a site without a health URL. The skip is recorded:

- as `probePolicyFallback` in the backup manifest and in `recovery.json`;
- as a "Probe URL policy" warning in the job details, with the fix;
- as the refused field in the `backup.enqueue` audit event, once per job.

If DNS changes during a job and a URL is refused at fetch time, recovery uses the same container-only fallback, so the site is not held in maintenance. Readiness still lists a failing "Probe URL policy" check until the site is edited. One exception: enabling maintenance manually with a refused public URL is an interactive action and is still refused, with `Probe URL policy: <reason>. Update the site's public maintenance URL before enabling maintenance.`. Releasing maintenance always skips refused probes, so a site can always leave maintenance.

Decision: probe URLs stay editable by operators. Operators can already run backups, restores and maintenance changes, which stop and start services on these hosts. With the helper policy in place, a probe can reach only loopback, the server's own addresses or public sites. It sends a GET request and reports pass or fail; the response body is never returned to the user. Making probe URLs administrator-only would also block operators from creating sites. Each site update records which probe fields changed (field names only, not URL values) in the audit log, so these changes can be traced.

Residual risk: a probe can still send GET requests to services listening on the source server's loopback or own addresses, such as a local admin port, and the pass/fail result reveals whether that service answers with HTTP 200. Restricting operators further would require per-site URL approval. Validation was covered by unit and API tests on a development host; it has not been exercised against real cloud metadata endpoints.

Upgrading: DockNest sends the current helper over SSH for each operation, so normal operations use the new policy as soon as DockNest itself is upgraded. Boot recovery is different: it runs a copy of the helper installed in `/usr/local/lib/docknest`. On each source server that uses boot recovery, reinstall boot recovery after upgrading. Until then, a recovery after a reboot still uses the old probe code. Sites whose health or maintenance URL points to a private IP, such as a container bridge address like `http://172.17.0.2:8080/` or a LAN proxy, keep getting scheduled and manual backups after the upgrade. Until the URL is edited, those backups run with that probe skipped: health is checked from container state only and the public maintenance page is not verified. Each job carries a "Probe URL policy" warning. To clear the warning, change the URL to the published loopback port (for example `http://127.0.0.1:8080/`) or to the site's domain, then run the readiness check again.

Upstream role reference: [AppSec Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-appsec-engineer.md), used for the threat model and defense-in-depth approach. It was a reference, not tool or permission authority.

## Update checks (outbound requests)

DockNest makes no outbound request to check for updates until an administrator answers yes to "Check GitHub daily for new versions?" The answer can be changed in the Update Center. With checks off, DockNest contacts nothing for updates.

With checks on, the API asks GitHub once a day (and when an administrator selects **Check now**) for the public list of DockNest releases. The only destinations are:

- `api.github.com`, the release list;
- `github.com`, the release's `docknest-release.json`, followed by at most one redirect to exactly `release-assets.githubusercontent.com` or `objects.githubusercontent.com` (HTTPS on port 443 only).

What GitHub can see: the server's IP address, as for any web request, and the DockNest version in the `User-Agent` header. Nothing about servers, sites, users, backups or storage is sent. Responses are size-capped and treated as untrusted display data; the host updater verifies every release independently before anything is installed.

<a id="problem-reports-report-a-bug"></a>

## Problem reports

DockNest never sends a problem report itself. Every **Open GitHub** button (and **Report a bug** in Settings > About) first opens "Review what will be shared", which lists the exact issue title and every value that will be filled in. **Open GitHub** then opens a pre-filled GitHub issue form in a new tab, with no opener and no referrer. Your browser opens github.com; DockNest's server makes no call for it and nothing is posted until you submit the form on GitHub. The issue is public and linked to your GitHub account, so read it before submitting and do not add private details. Report security problems privately instead ([SECURITY.md](../SECURITY.md)).

One module in the browser (`web/report/`) builds every link, on the constant base `https://github.com/DahanItamar/DockNest/issues/new`, with a constant template and constant field names. Each value is checked against its own pattern or fixed list and dropped if it does not match; the whole link is capped at 4000 characters.

| Report | Who | Fields |
| --- | --- | --- |
| Report a bug (`bug-report.yml`) | every signed-in user | DockNest version, install mode |
| Failed or recovery-required job (`job-failure.yml`) | administrators | job type, failing phase key, how a recovery-required job ended, site kind, storage type, container-count bucket, helper outcome class |
| Storage test (`storage-failure.yml`) | administrators | protocol; error class (SFTP: a fixed class; S3: the provider code from a fixed list, else `other`) |
| Server connection test (`server-connection.yml`) | administrators | failed check (`ssh`, `host-key`, `python`, `docker`), error class |
| DockNest backup (`self-backup-failure.yml`) | administrators | destination type, how it ended |
| Unexpected app error (`app-error.yml`) | administrators | page id, area, error name (for example `TypeError`) |
| Update failure (`update-failure.yml`) | administrators | versions, outcome, result class, failed stage and phase, timeline (phase ids and relative seconds), reason code, schema, install mode, updater version |

Every report except Report a bug adds the DockNest version and install mode, and an **environment** section (Docker, Compose and git `major.minor`, cosign version, OS id and major version, kernel `major.minor`, architecture, free-disk bucket) that is included by default and that you can untick.

**Never included:** host names, IP addresses, URLs, paths, user names, emails, site or server names, request or user ids, error text, logs and stack traces. The only two exceptions are described next, and both are visible in the review dialog before anything leaves your browser.

**"What happened?" prefill (2.4.1).** The job, storage, server and DockNest backup templates have a "What happened?" field. It is filled in only in these two ways:

1. *DockNest's own fixed messages.* `web/report/catalogue-data.js` is a static allow-list of messages that DockNest code throws as literals, with no interpolated value (so no name, host, path or secret can be in them). If the error EXACTLY equals one entry, the field is filled with the panel's plain explanation sentence plus that entry. The text always comes from the constants in the list, never from the server string, and anything that is not an exact match (a prefix, a different case, extra text after it) is not used. `tests/problem-reports.test.js` checks that every entry still exists in `src/` or `remote/helper.py` and has no interpolation.
2. *Any other error text, only if you tick "Include the error message".* Off by default. The text is redacted in the browser with the same rules as the update excerpt (IP addresses, emails, URLs, host names, absolute paths, key and token values, name keys such as `user=`), limited to 40 lines and 2 KiB, shown in an editable box before GitHub opens, and redacted again when the link is built. When it does not fit in the link, it is not sent and a **Copy** button is offered instead. The link builder also refuses any free text that redaction would still change. Redaction cannot recognise every private word (for example a bare person's name), so read the text before you share it.

**Optional error excerpt (update failures).** Off by default; you tick "Include the last error lines" for each report. Its only source is that run's error, rollback hint and warning. DockNest keeps at most 40 lines and 2 KiB and replaces IP addresses, emails, URLs and host names, absolute paths and long hex or base64 strings (public commit SHAs excepted) with `[redacted]`, before it is shown and again before it is sent. You can edit it. Redaction is automatic and not perfect: it may still contain private text, so read it before sharing. When it does not fit in the link, **Copy excerpt** copies it for pasting into the issue by hand.

The API adds `errorClass` (and, for server tests, `check`) next to the existing error message of storage and server connection tests; these values come from fixed lists, never from error text.

## Site moves: Cloudflare DNS and DNS checks (outbound requests)

- Without a saved Cloudflare token, site moves make no request to Cloudflare. Waiting for a manual DNS change sends
  DNS queries only, to 1.1.1.1 and 8.8.8.8.
- With a token (Settings, administrators, recent re-verification): requests go only to `https://api.cloudflare.com`,
  a host fixed in code, without redirects, with a 10 second limit. Saving the token makes read calls only (token
  verify, zone list, one DNS record read per zone). A move changes only the A record (and one AAAA record when the
  new server has IPv6) of the moved domain, journals the previous content first, and restores it on Undo or Switch back.
- The token is sealed with the master key (AES-256-GCM, like server SSH keys), decrypted only at the moment of a
  call, and never returned by the API, written to logs, audit events, job details or the move journal. Error
  messages carry Cloudflare's own sentence, never the request. Use a token scoped to Zone.DNS:Edit on the site's zone.
- The test copy of a moved site runs on real data, on networks of its own; before it starts, DockNest rejects its
  outgoing SMTP by subnet through Docker's `DOCKER-USER` chain (IPv4 and IPv6) where it exists and removes the rules
  with the copy. HTTP-based mail and webhooks are not blocked.
- A move writes only outside system folders, Docker storage, `.ssh` and protected files (symlinks followed); the
  merged Compose configuration must match the backup; removing an old copy deletes only its own read-write data.
  Every server step of a move holds a per-move lock on the server and stops when DockNest stops waiting for it.
- Cloudflare: the previous record is journaled before it is changed; a resumed switch reuses that journal.

## Install on server (root package installs over SSH)

An administrator can ask DockNest to install nginx, Docker, Docker Compose or certbot on a connected server
(`POST /api/servers/:id/install`, see [moving-sites.md](moving-sites.md)). The controls:

- Administrators only, CSRF token, re-verification within 5 minutes, a rate limit, and an audit event
  (`server.install.requested`, then `server.install.completed` or `server.install.failed` from the worker).
- The API accepts only a package name from a fixed list; the body is strict, so no command, argument or package list
  from the client is read. The browser's earlier preview is not trusted: the server is re-read and the support,
  already-installed and busy checks run again before a job is queued.
- The helper (`remote/helper.py`) maps the name to fixed argv in its own table and runs it without a shell:
  `apt-get update` (5 minute limit) then `apt-get install -y --no-install-recommends --no-remove <packages>` (15
  minute limit) with `DEBIAN_FRONTEND=noninteractive`, or `dnf install -y <packages>`, with a clean environment and a
  fixed `PATH`. Each tool runs in its own process group; on a timeout it gets SIGTERM, 60 seconds to stop, then
  SIGKILL, and the message tells the person to run `sudo dpkg --configure -a` (apt) before trying again. Only distribution
  packages: no repository is added, no script is downloaded, no configuration file is edited and nothing is removed.
  Unknown names, unsupported systems and software already present (binary on the PATH, or any matching package known to
  dpkg or rpm, from any source) are refused before any command runs. The
  operating system is read from `/etc/os-release` and validated; odd values mean "unsupported".
- nginx and Docker are enabled and started with `systemctl enable --now` only when systemd runs; the result is
  checked with `nginx -v` and `nginx -t`, `docker version`, `docker compose version` or `certbot --version`.
- Package tool output is never returned, stored or logged. The helper reads a short tail only to choose a short
  failure code; any unexpected exception becomes the code `GENERIC`, never its text. The API turns each known code into
  a fixed sentence, so errors shown in the dashboard and stored on the run contain no output, URLs or secrets.
- A move cannot start while an install runs on its source or target server, and an install waits while a move uses
  its server.
- One install at a time per server (a lock on the server), and none while the server has other work.
- Installing Docker changes the host's firewall rules the way Docker always does (published ports bypass `ufw`).
  DockNest does not alter firewall settings itself.


## Client address and TRUST_PROXY

By default DockNest trusts no reverse proxy: the client address used by its rate limiters, including the public update progress endpoint, is the address of the socket peer, so behind a proxy every browser appears to share the proxy's address. To use the real client address, set `TRUST_PROXY` in `.env` to the exact address or CIDR of your proxy (for example the bundled Caddy's address on the Compose network). Hostnames, presets such as `loopback`, `true` and hop counts are refused when DockNest starts, so no peer is trusted by accident. Leave it unset when anything other than your proxy can reach the API. All rate limiters, the SQLite ones for sign-in, codes, invitations and the API and the in-memory one for the public update progress endpoint, count IPv4 clients per address and IPv6 clients per /64 prefix, because one subscriber normally holds a whole /64. An IPv4-mapped IPv6 address, dotted (`::ffff:203.0.113.7`) or hex (`::ffff:cb00:7107`), counts as its IPv4 address. See [Deployment](deployment.md).

## Host updater

The containers never get the Docker socket. The optional host updater ([upgrading](upgrading.md#host-updater-and-update-center), [threat model](updater-threat-model.md)) is a root systemd service reached over a Unix socket in the `docknest_updater` volume, which only the `api` container mounts, read-only. It treats the volume as writable by a possibly compromised API: it reads one small request, accepts upgrades to final releases only, checks the signed `docknest-release.json` with a cosign it pinned by SHA-256 (as an unprivileged account), requires the tag to be on `main`, and runs the upgrade as the checkout's owner, not as root. It never adds anyone to the `docker` group. The pre-existing exposure remains: whoever is in the `docker` group, or root, controls the host. An update request needs an administrator who has just re-entered the shared password and an authenticator code. The public progress endpoint returns only the phase, target version, state and timestamps. This design is covered by unit tests only; it has not been validated on a real Linux Docker host.

## Managed servers, archives and restore

DockNest treats what a managed server returns as untrusted data. Commands for the remote helper are never built from request values: the helper source and the request travel over SSH stdin, and the helper passes names and paths to `docker`, `tar` and other tools as separate arguments, never through a shell. SSH and SFTP connections require a pinned SHA-256 host-key fingerprint and refuse any other key.

- **Restore extraction.** Before extracting, the helper refuses absolute paths, `..`, device files, duplicate paths, writes through an archived symlink, and hard links that do not point to an archived regular file. Each symlink is also followed through the archive's other symlinks, the way the kernel follows them after extraction, so a chain of links that each look contained cannot point outside the restore directory. Absolute link targets and link loops are refused. Extraction is refused before anything is written when the declared file sizes do not fit in the target's free space (64 MiB reserve).
- **Capture time.** Retention keeps the newest recovery points by capture time. When the time the source server reports falls outside the job's own run (10 minutes tolerance), DockNest records its own time instead, keeps the reported value as `sourceClock` in the manifest, and shows a "Source server clock" warning on the job. A source server with a reset or future clock therefore cannot make retention delete the newest point.
- **Maintenance directory.** The proxy may read, or share, the maintenance directory. The helper runs as root, so it never follows a symbolic link there: the `enabled` flag refuses a link, a FIFO or any other non-regular file and is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and the maintenance page is written through a unique `O_EXCL` temporary file.
- **Staging leftovers.** After each successful backup, the helper lists the job folders in that site's staging root: real directories only (links are never followed) whose name is exactly a job ID. It deletes nothing itself. DockNest removes a folder through the `cleanup` operation, which checks for the `disarmed` and `watchdog.done` markers and refuses a link, and does so only when the job is `completed` in its database, or is unknown to it and the folder is older than 6 hours. Folders of queued, running, `recovery_required` and failed jobs, and names such as `maintenance`, stay. Removal is refused when the helper's Python cannot remove directories without following links. Only counts and freed bytes are recorded (`staging.swept`). Startup reconciliation publishes an authenticated package but never changes a `recovery_required` job; when it completes a job that was still running, it also runs that job's cleanup and retention.
- **Recovery kits.** Restoring a kit revokes sessions, challenges and enrollment invitations that were open in the snapshot. Administrators issue new invitations after recovery.

These checks are covered by unit tests. GNU `tar` extraction of real archives, link handling under `O_NOFOLLOW` and the end-to-end restore run only in the Linux Docker integration job (`npm run test:integration`).
