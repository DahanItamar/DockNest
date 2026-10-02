# Validation status and release gate

Automated checks cover only the behavior asserted by their test suite. Docker/SSH/Linux integration and a real recovery remain required. No real backup or restore has been proven merely by compiling this project. Record the date, software versions, fixture, observed result, and evidence for each check below.

## Real Linux integration checklist

- [ ] Build and start Compose; restart API and worker; verify shared SQLite persistence and secret permissions.
- [ ] Complete first-admin token setup, authenticator enrollment, password+TOTP login, recovery-code use, session expiry, and setup lockout.
- [ ] Verify HTTPS, secure cookies, origin protection, authenticated downloads, and rate limiting.
- [ ] Connect two Linux SSH servers; verify Docker, Python, architecture, disk capacity, and independently pinned host keys. Changed host keys must fail closed.
- [ ] Capture sites with a database, uploaded files, named volumes, bind mounts, writable layers, image IDs, Compose/env files, and ownership/symlinks.
- [ ] Verify all included containers and other writers are identified; unsupported mounts or unresolved dependencies block a complete backup.
- [ ] Backup site A while site B remains active; measure container downtime and public maintenance downtime separately.
- [ ] Verify graceful database shutdown; forced/timeout shutdown must not be called consistent.
- [ ] Verify the site restarts and passes direct health checks before compression/transfer; edits to live data do not modify the staging copy.
- [ ] Interrupt SSH and stop/restart the central manager during shutdown/copy. Verify the local watchdog restarts the site, verifies health, and clears maintenance safely.
- [ ] Fill staging/central disks and interrupt transfer. Verify no incomplete backup is published and earlier good backups survive.
- [ ] Perform eight successful backups with retention seven, plus pinned backups. Verify retention excludes pinned and actively downloaded/restored packages.
- [ ] Verify daily scheduling across timezone/daylight-saving boundaries, disabled policies, restart catch-up behavior, and non-overlap per site/server.
- [ ] Download a large package with HTTP range/resume, authenticate it offline, and detect intentional ciphertext corruption.
- [ ] Restore to a clean compatible host without registry access. Verify images, DB rows, assets, UID/GID, modes, settings, and key application actions.
- [ ] Verify restored copies use distinct names/ports and cannot send real emails, payments, or other outbound actions by default.
- [ ] Verify maintenance 503/Retry-After/no-store responses on the original HTTPS domain and API JSON 503 responses; another site remains unaffected.
- [ ] Verify maintenance is available with the central manager offline, polling reloads the original GET page after health recovery, and POST actions are never replayed.
- [ ] Recover the central manager from independent state/backups/key copies; decrypt and restore without the original manager.
- [ ] Review sanitized audit/job logs and verify no secrets are leaked.

## Known release limitations

Controlled replacement of an existing site is blocked until a validated pre-replacement backup and rollback workflow exists. Generic proxy provisioning, external-source adapters, full graceful-shutdown profiles for every database, and deployment-specific operational alerts require further work and validation. Check implemented API/UI behavior against the original spec; do not infer support from this checklist.

## Current verification evidence

On 2026-10-02, `npm run check` passed the production build and 49 Node tests, including the Python helper suite. Coverage includes authentication/session enforcement, API authorization, authenticated encryption/tamper rejection, queue and retention, scoped configuration browsing, static settings, SFTP streams and private ZIP staging cleanup.

Actual isolated Linux integration passed with Docker 29.1.3: three disposable pinned-SSH hosts, password/key SFTP probes, real Docker capture and second-host restore, database records, mounts, writable layers, ownership, hardlinks, temporary RAM folders, bundled images and isolated grouped networks. Corruption, copy failure and watchdog recovery checks passed. Native static discovery, encrypted SFTP capture and second-host file restore also passed while nginx remained online. Evidence is retained in ignored local QA data.

A native static production backup and private restore verified 33 files and a Full ZIP passed CRC checks for all 45 entries. A Docker application backup also completed after its configuration was corrected. These observations are site-specific; private names, addresses, job IDs, archive sizes, operational scripts and restore paths are intentionally excluded from Git. They do not prove every business workflow or production database is recoverable.

Browser fixtures passed responsive Backup capacity at three heights, stable partial pages, resize preservation, site configuration/discovery and original recovery actions. System health checks cover API/worker availability, failed-job attention, hung requests, recovery, both sidebar layouts and reduced motion. Documentation screenshots intercept every API request with mock responses.

Production health and anonymous-access protections were checked after deployment. Some CDN policies reject server-side public probes; static file readiness reports that limitation rather than changing visitor hosting. Required Docker maintenance and consistency checks remain enforced.

The checklist above still requires deployment-specific acceptance. Replacement restores, custom privilege/network adapters, complete independent disaster recovery and operational alerts remain outside validated scope. Build or browser success alone is never a real recovery validation.
