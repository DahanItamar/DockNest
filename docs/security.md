# Authentication and access

The system uses one shared system password plus a separate authenticator identity for each authorized person. Login asks for the shared password and a six-digit TOTP code together, or an unused personal recovery code. The second factor identifies the person's account and role. Knowing the shared password alone does not grant access.

## Enrollment and account lifetime

The first administrator is provisioned through the local PowerShell setup command. It prompts for the selected password, opens a temporary local QR/recovery page, and requires a valid authenticator code before activating the administrator. The QR file is deleted after confirmation. The web login only shows Password and 2FA code. The legacy API setup route still requires the local setup token; it cannot expose a pending administrator authenticator with the shared password alone. Administrators create named operator invitations in Access management. An invitation expires after 15 minutes and can be used once. Its enrollment URL places the opaque token in a browser fragment; the browser submits it only to the enrollment endpoints.

The invited person opens the link, enters the shared password, scans the locally generated authenticator QR, and confirms a code. Password verification produces a short-lived enrollment proof required for confirmation. An account awaiting enrollment cannot log in. Save the resulting personal recovery codes privately; each works once. The administrator distributes the invitation and shared password through their chosen private channels: this application does not send email invitations automatically.

The 15-minute expiry applies to enrollment, not to the account or authenticator. An enrolled account remains authorized until revoked. Regenerating an invitation invalidates the earlier link. Resetting an active operator’s authenticator requires confirming their name and signs them out; they must complete the new invitation before logging in again. Administrators cannot revoke or reset administrator accounts through these operator controls. Treat QR images, authenticator secrets, invitation links, and recovery codes as credentials; do not publish them.

## Permissions and revocation

Administrators manage invitations, revoke access, and rotate the system password. Operators cannot use those administrator routes. Removing a person immediately disables their account and invalidates their sessions. Neither the shared password nor their previous authenticator/recovery codes can reactivate a disabled account.

Sensitive administration requires password plus that administrator's personal factor verified within the previous five minutes. The server returns REAUTH_REQUIRED when another verification is needed. Rotating the shared password signs everyone out and invalidates pending login/enrollment challenges and invitations. Tell authorized people the replacement password privately.

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
- A redirect is followed only to the same host or to another configured site domain, for at most five hops. Each hop is validated and pinned again. A redirect to any other host is not followed, and the probe fails because the redirect status is not the expected result.
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
