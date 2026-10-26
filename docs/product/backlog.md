# Product backlog (next 25 items)

Date: 2026-10-21. Owner: Product Manager. Ordered by target release, then by dependency.

**Owner role:** the [agency-agents](https://github.com/msitarzewski/agency-agents) role that should build the ticket. These roles are guidance only and grant no tool or permission authority.

**Model / effort tier:**
- **opus-high:** security, data safety, architecture
- **sonnet-high:** features
- **sonnet-medium:** QA, review, tooling
- **haiku-medium:** docs

**Definition of done for every ticket:**
- `npm run check` passes.
- Any change to capture, restore, retention, storage or upgrade also passes `npm run test:integration` on Linux before release notes call it validated.
- No secrets reach Git, logs or fixtures.
- It is a small section commit.

## Summary

| ID | Title | Target | Owner role | Tier | Depends on |
| --- | --- | --- | --- | --- | --- |
| PM-01 | Upgrade fixtures from 2.0.0 with exact state comparison | 2.1.0 | Database Reliability Engineer | opus-high | safe-upgrade migrations |
| PM-02 | Pre-migration snapshot and rollback drill in CI | 2.1.0 | DevOps Automator | opus-high | PM-01 |
| PM-03 | Real S3 + Object Lock Linux integration run | 2.1.0 | Reality Checker | sonnet-medium | `feat/s3-storage` |
| PM-04 | Guard test against merged "Verified" wording | 2.1.0 | Test Automation Engineer | sonnet-medium | `docs/verification-wording` |
| PM-05 | One outbound-URL policy for probes, webhooks and pings | 2.1.0 | Security Engineer | opus-high | `fix/probe-url-ssrf` |
| PM-06 | Retention protects the latest isolated-restore-passed backup | 2.2.0 | Backend Architect | opus-high | — |
| PM-07 | Updater threat model and trigger-channel ADR | 2.2.0 | Security Engineer + Software Architect | opus-high | PM-02 |
| PM-08 | Signed release manifest verification in the host updater | 2.2.0 | DevOps Automator | opus-high | PM-07 |
| PM-09 | Settings: update check, "What's new", update status | 2.2.0 | Frontend Developer | sonnet-high | PM-07, PM-08 |
| PM-10 | Update and downgrade path tests with forced failures | 2.2.0 | Test Automation Engineer | sonnet-medium | PM-08 |
| PM-11 | Restructure ADR: module boundaries, no behavior change | 2.3.0 | Software Architect | opus-high | 2.2.0 shipped |
| PM-12 | Lint, format and release-please | 2.3.0 | Git Workflow Master | sonnet-medium | PM-11 |
| PM-13 | API response snapshot tests guarding the restructure | 2.3.0 | API Tester | sonnet-medium | — |
| PM-14 | Opt-in heartbeat ping | 2.4.0 | SRE | sonnet-high | PM-05 |
| PM-15 | Scheduled integrity scrubs | 2.4.0 | Backend Architect | sonnet-high | — |
| PM-16 | Notification engine: email, webhook, ntfy | 2.4.0 | Backend Architect | opus-high | PM-05 |
| PM-17 | Notification settings UI with test send | 2.4.0 | Frontend Developer | sonnet-high | PM-16 |
| PM-18 | Explainable per-site recovery readiness | 2.4.0 | UX Architect | sonnet-high | PM-04, PM-15 |
| PM-19 | Storage-cost benchmark vs restic and Kopia | 2.3.0 (parallel) | Performance Benchmarker | sonnet-medium | — |
| PM-20 | Prerequisite checker and first-restore checklist | 2.4.0 | Frontend Developer | sonnet-high | — |
| PM-21 | Timed clean-VPS onboarding walkthrough | 2.4.0 | Reality Checker | sonnet-medium | PM-20 |
| PM-22 | Scheduled restore drill ADR | 2.9.0 | Software Architect + Security Engineer | opus-high | PM-15, PM-16 |
| PM-23 | Scheduled restore drills | 2.9.0 | Backend Architect | opus-high | PM-22 |
| PM-24 | Per-site RPO/RTO targets and report | 2.5.0 | Backend Architect | sonnet-high | PM-23 |
| PM-25 | Install-report and interview templates | 2.2.0 | Technical Writer | haiku-medium | — |

---

## 2.1.0 — finish the foundation

### PM-01 — Upgrade fixtures from 2.0.0 with exact state comparison
- **Problem:** `src/db.js` upgrades schemas with ad hoc additive `ALTER TABLE ... ADD COLUMN` and no schema version. The owner's first rule is that upgrades never break data or configuration. Versioned migrations need fixtures that prove it.
- **Acceptance criteria:**
  - Fixtures are SQLite files created by a 2.0.0 release with synthetic data. They cover: admin and operator users with factors, servers, sites with each `deliveryMode`, policies, backups (pinned and unpinned) and verification history.
  - Upgrading each fixture to HEAD preserves every pre-existing row and field. Comparison is exact, except for documented new columns.
  - Upgrading twice is idempotent.
  - A fixture with an unknown future schema version refuses to start, with a clear message.
- **Owner role:** [Database Reliability Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-database-reliability-engineer.md) · **Tier:** opus-high · **Depends on:** the safe-upgrade migration work · **Target:** 2.1.0

### PM-02 — Pre-migration snapshot and rollback drill in CI
- **Problem:** a migration that fails halfway must not leave a mixed state.
- **Acceptance criteria:**
  - Before any migration, the upgrade takes a consistent snapshot using the SQLite online backup API (as `scripts/recovery-kit.js` does).
  - A migration injected to fail mid-way leaves the original database byte-identical after rollback.
  - CI runs this drill.
  - The upgrade script prints the snapshot path and how to roll back.
- **Owner role:** [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) · **Tier:** opus-high · **Depends on:** PM-01 · **Target:** 2.1.0

### PM-03 — Real S3 + Object Lock Linux integration run
- **Problem:** `feat/s3-storage` is tested against an in-process fake S3. Real providers differ in multipart, retention-header and consistency behavior.
- **Acceptance criteria:**
  - A Linux run against a real S3-compatible endpoint with Object Lock enabled (MinIO in CI, plus one public provider by hand). It covers publish, read-back authentication, restore, retention delete of an unlocked object, and refused deletion of a locked object.
  - The evidence is recorded in `docs/acceptance.md` with versions.
  - The README stays at "in beta" wording until this passes.
- **Owner role:** [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) · **Tier:** sonnet-medium · **Depends on:** `feat/s3-storage` · **Target:** 2.1.0

### PM-04 — Guard test against merged "Verified" wording
- **Problem:** on `main`, recovery rows fall back to a single `Verified` / `Unverified` badge (`web/recovery-pages.jsx`), even though the API exposes four separate results. Wording regressions are easy to make.
- **Acceptance criteria:**
  - A Node test scans `web/`, `README.md` and `docs/releases/` for a bare "Verified" status claim not tied to a named result, using an allowlist for "Integrity verified" and similar.
  - The test fails on the current `main` fallback and passes once the `docs/verification-wording` branch is merged.
- **Owner role:** [Test Automation Engineer](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-test-automation-engineer.md) · **Tier:** sonnet-medium · **Depends on:** `docs/verification-wording` · **Target:** 2.1.0

### PM-05 — One outbound-URL policy for probes, webhooks and pings
- **Problem:** URL validation today lives in the Python helper (`public_probe` in `remote/helper.py`), and SSRF hardening is in flight. 2.2.0 to 2.4.0 add outbound calls from the Node manager (update check, heartbeat, webhooks, ntfy). Two divergent validators would be a security risk.
- **Acceptance criteria:**
  - A documented policy covers schemes, credentials in the URL, private and link-local ranges, DNS rebinding (resolve, then connect to the resolved address), redirects, timeouts and response-size caps.
  - The Node and Python implementations share one test vector file.
  - Every outbound call site uses the policy. A test fails if code calls `fetch` outside the wrapper.
- **Owner role:** [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) · **Tier:** opus-high · **Depends on:** `fix/probe-url-ssrf` · **Target:** 2.1.0

## 2.2.0 — safe in-app updates

### PM-06 — Retention protects the latest isolated-restore-passed backup
- **Problem:** count retention (`retain` in `src/engine.js`) never deletes pinned packages or the latest *application*-passed package (`src/artifact-journal.js`). A site with no configured data checks can lose its only package with a passed isolated restore to ordinary rotation.
- **Acceptance criteria:**
  - Per site, the newest backup with `isolatedRestore` = passed is excluded from count retention, like the application case.
  - The UI shows "Protected: latest restore-tested" and the extra storage this protection uses.
  - Tests cover: eight backups with retention seven where the restore-tested one is oldest; protection moving to a newer restore-tested backup; a failed later restore attempt on the same package not removing protection, since evidence history is append-only (the PM-11 ADR records whether that is desired).
  - Upgrading from 2.1.0 changes no stored rows.
- **Owner role:** [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) · **Tier:** opus-high · **Depends on:** — · **Target:** 2.2.0

### PM-07 — Updater threat model and trigger-channel ADR
- **Problem:** the planned host-side systemd updater runs as root. If the dashboard can trigger it, a dashboard compromise must not become arbitrary root code execution or a downgrade attack.
- **Acceptance criteria:**
  - An ADR in `docs/` covers: the trigger mechanism (for example, a request file in a dedicated volume that the updater validates, carrying only a release identifier and no commands); signature and manifest verification; allowed versions (no downgrade below the minimum schema-compatible version); and admin re-authentication within 5 minutes (the existing sensitive-action rule in `docs/security.md`).
  - It also covers audit events, a rate limit, a kill switch, and a statement that no container gains the Docker socket.
  - Security Engineer sign-off is required.
- **Owner role:** [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) + [Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md) · **Tier:** opus-high · **Depends on:** PM-02 · **Target:** 2.2.0

### PM-08 — Signed release manifest verification in the host updater
- **Acceptance criteria:**
  - The updater verifies the release manifest signature and image digests (from the 2.1.0 GHCR signing work) before pulling.
  - A tampered manifest, unknown key or digest mismatch aborts with no state change.
  - The updater runs the PM-02 snapshot, then drains the worker, then switches, then runs a health gate, with automatic rollback on failure.
  - Each step writes a sanitized status file the dashboard can read.
- **Owner role:** [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) · **Tier:** opus-high · **Depends on:** PM-07 · **Target:** 2.2.0

### PM-09 — Settings: update check, "What's new", update status
- **Acceptance criteria:**
  - The update check is **off until an admin enables it**, or follows the owner's Q4 decision. When enabled, it sends one unauthenticated GET to the GitHub releases API with no install identifier.
  - A "What's new" modal renders the release notes as text only, with no remote HTML.
  - Update and rollback progress comes from the PM-08 status file.
  - Operators see the version but cannot update.
  - A browser test covers every state, including "updater not installed".
- **Owner role:** [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) · **Tier:** sonnet-high · **Depends on:** PM-07, PM-08 · **Target:** 2.2.0

### PM-10 — Update and downgrade path tests with forced failures
- **Acceptance criteria:**
  - Paths N-2→N and N-1→N, and a command-line downgrade N→N-1 from the pre-upgrade snapshot (the update center itself never downgrades).
  - Failure is injected at download, verify, snapshot, drain, switch and health. Each leaves the previous version running with identical state, using the PM-01 comparison.
  - Runs in CI on Linux.
- **Owner role:** [Test Automation Engineer](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-test-automation-engineer.md) · **Tier:** sonnet-medium · **Depends on:** PM-08 · **Target:** 2.2.0

## 2.3.0 — maintainable codebase

### PM-11 — Restructure ADR: module boundaries, no behavior change
- **Problem:** core logic is concentrated in long single-line functions in `src/engine.js` and `src/server.js`. Reviews and contributions are slow.
- **Acceptance criteria:**
  - An ADR names the target modules (jobs, capture, restore, retention, storage, verification, routes) and a migration order of one module per commit.
  - Rule: no API, schema or helper protocol change.
  - Records open decisions found along the way, such as the PM-06 edge case.
- **Owner role:** [Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md) · **Tier:** opus-high · **Depends on:** 2.2.0 shipped · **Target:** 2.3.0

### PM-12 — Lint, format and release-please
- **Acceptance criteria:**
  - The formatter and linter run in `npm run check` (exact tooling chosen in the PR; no `package.json` version change outside the release process).
  - Formatting goes in one commit, excluded from blame through `.git-blame-ignore-revs`.
  - release-please builds the changelog and release PR from conventional commits.
- **Owner role:** [Git Workflow Master](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-git-workflow-master.md) · **Tier:** sonnet-medium · **Depends on:** PM-11 · **Target:** 2.3.0

### PM-13 — API response snapshot tests guarding the restructure
- **Acceptance criteria:** snapshot tests for all authenticated GET routes, plus `plan`/`restore-plan` responses on synthetic fixtures. Any shape change fails CI unless the snapshot update is reviewed.
- **Owner role:** [API Tester](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-api-tester.md) · **Tier:** sonnet-medium · **Depends on:** — · **Target:** 2.3.0

### PM-19 — Storage-cost benchmark vs restic and Kopia
- **Problem:** DockNest stores full packages without dedup. Users will ask what that costs. Without numbers, the comparison is guesswork.
- **Acceptance criteria:**
  - A reproducible script on Linux fixtures covers three synthetic sites (small static, a WordPress-like app with a database, a 5 GB uploads site) over a 30-day simulated change schedule.
  - It reports stored bytes, backup duration, site pause time (DockNest) and restore time for DockNest, restic and Kopia, with versions.
  - The method and raw output are published in `docs/`. No marketing claims are made beyond the measured fixtures.
- **Owner role:** [Performance Benchmarker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-performance-benchmarker.md) · **Tier:** sonnet-medium · **Depends on:** — · **Target:** 2.3.0 (parallel)

## 2.4.0 — know when something is wrong

### PM-14 — Opt-in heartbeat ping
- **Problem:** the manager cannot alert when its own host is down ([independent-recovery.md](../independent-recovery.md)).
- **Acceptance criteria:**
  - An admin can set one ping URL (Healthchecks or Uptime Kuma push style).
  - The worker pings after each scheduler cycle in which the worker is healthy, and on each completed backup. A failure-ping variant fires on `failed` or `recovery_required`.
  - The request carries no body or identifiers and uses PM-05.
  - Disabled by default. Audit event on change.
- **Owner role:** [SRE](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-sre.md) · **Tier:** sonnet-high · **Depends on:** PM-05 · **Target:** 2.4.0

### PM-15 — Scheduled integrity scrubs
- **Problem:** full package authentication happens only at publication, at restore, or through a manual `POST /api/backups/:id/scrub`. `tickScheduler` queues backups only. Same-size corruption goes undetected until restore day.
- **Acceptance criteria:**
  - A scrub cadence setting (default proposal: every retained package once per 30 days, oldest-checked first, at most N per day).
  - Scrubs never stop source services and respect the deployment hold.
  - A failed scrub marks the package as it does today and raises a notification (PM-16).
  - The dashboard shows when each package was last authenticated.
- **Owner role:** [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) · **Tier:** sonnet-high · **Depends on:** — · **Target:** 2.4.0

### PM-16 — Notification engine: email, webhook, ntfy
- **Acceptance criteria:**
  - Events: backup failed, restart failed / `recovery_required`, scrub failed, storage unreachable, worker stale, and (later) drill failed.
  - Channels: SMTP (STARTTLS required), a generic JSON webhook with an optional HMAC signature, and ntfy.
  - Channel secrets are sealed with the master key, included in the recovery kit, and never logged.
  - Message bodies contain the site display name, event and time only: no paths, hosts, environment values or error text beyond the sanitized cause.
  - Deduplication and a rate limit apply. Delivery success or failure is visible in System health.
  - Tests cover redaction for every event type.
- **Owner role:** [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) (with Security Engineer review) · **Tier:** opus-high · **Depends on:** PM-05 · **Target:** 2.4.0

### PM-17 — Notification settings UI with test send
- **Acceptance criteria:**
  - Admins add, edit and remove channels, choose events, and send a test message. Operators get a read-only view.
  - Secrets are never echoed back after saving.
  - Accessible forms pass the existing browser and mobile checks.
- **Owner role:** [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) · **Tier:** sonnet-high · **Depends on:** PM-16 · **Target:** 2.4.0

### PM-18 — Explainable per-site recovery readiness
- **Acceptance criteria:**
  - Each site shows a readiness level computed from: last usable capture age against its schedule; the latest integrity, consistency, isolated restore and application results with dates; open blockers; and scrub age.
  - The level is never higher than its weakest *required* result.
  - Every level links to the facts behind it. "Not tested" is shown as not tested, never as passed.
  - No data is stored beyond what already exists. The level is computed.
- **Owner role:** [UX Architect](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ux-architect.md) (design) + Frontend Developer (build) · **Tier:** sonnet-high · **Depends on:** PM-04, PM-15 · **Target:** 2.4.0

### PM-20 — Prerequisite checker and first-restore checklist
- **Acceptance criteria:**
  - Server onboarding reports root UID, Python 3, Docker version (28+ for grouped restores), architecture (x86_64 qualified), free disk and SFTP/S3 reachability, each with a one-line fix. These are the conditions `planRestore` and the support matrix require today.
  - A dismissible checklist tracks: storage, server, site, readiness, first backup, first isolated restore passed.
- **Owner role:** [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) · **Tier:** sonnet-high · **Depends on:** — · **Target:** 2.4.0

### PM-21 — Timed clean-VPS onboarding walkthrough
- **Acceptance criteria:**
  - A scripted walkthrough on fresh Linux fixtures (manager plus a source with a synthetic site plus SFTP) records the elapsed time of each step to a first passed isolated restore.
  - It runs each release and stores the result in the release notes.
  - The first run sets the baseline for the under-60-minute goal.
- **Owner role:** [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) · **Tier:** sonnet-medium · **Depends on:** PM-20 · **Target:** 2.4.0

## 2.5.0 — proof on a schedule

### PM-22 — Scheduled restore drill ADR
- **Acceptance criteria:**
  - The ADR decides:
    - drill target selection (a dedicated server by default; the source server only with an explicit opt-in);
    - resource limits (Docker `--cpus`, `--memory`, a disk quota or a pre-check of free space against `backup.size*3+1GiB`, as `planRestore` uses);
    - TTL teardown, which survives manager restart (journalled like captures);
    - network policy (keep `none` / isolated internal, no egress);
    - concurrency (one drill per target; never alongside a capture on the same server, as `claimJob` already serializes per server);
    - evidence linkage (a drill result is per package).
  - Security Engineer and Reality Checker sign off.
- **Owner role:** [Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md) + [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) · **Tier:** opus-high · **Depends on:** PM-15, PM-16 · **Target:** 2.9.0 (ADR: [restore-tests.md](../restore-tests.md))

### PM-23 — Scheduled restore drills
- **Acceptance criteria:**
  - Per-site drill cadence. The scheduler queues `restore` jobs in drill mode against the chosen target.
  - Measured restore duration is stored.
  - Teardown happens after the configured checks or the TTL, whichever comes first, and leaves no containers, networks, images loaded only for the drill, or paths. This is verified by a Linux integration test.
  - Failure raises a notification and keeps evidence. The append-only history is preserved.
  - Not called validated until Linux integration passes for single-container, grouped and static sites.
- **Owner role:** [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) · **Tier:** opus-high · **Depends on:** PM-22 · **Target:** 2.9.0 (product name "Automatic restore tests")

### PM-24 — Per-site RPO/RTO targets and report
- **Acceptance criteria:**
  - Per-site RPO and RTO targets.
  - RPO actual = now minus the capture time of the latest *usable* package (integrity passed, not quarantined). RTO actual = the latest drill's measured restore duration, never capture duration.
  - A dashboard view and a CSV export.
  - Sites without drill data show "RTO unknown".
- **Owner role:** [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) · **Tier:** sonnet-high · **Depends on:** PM-23 · **Target:** 2.5.0

## Docs and research

### PM-25 — Install-report and interview templates
- **Problem:** there are no adoption signals beyond stars ([metrics.md](metrics.md)), and personas are unvalidated ([personas.md](personas.md)).
- **Acceptance criteria:**
  - A GitHub issue form "Install report" (outcome, DockNest version, OS/Docker/Python versions, architecture, steps that failed; synthetic names only, with a privacy warning that mirrors the support matrix's sanitized intake).
  - A Discussions category "Show your setup".
  - A 10-question interview guide in `docs/product/` that collects no client names or domains.
- **Owner role:** [Technical Writer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-technical-writer.md) (with [UX Researcher](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ux-researcher.md)) · **Tier:** haiku-medium · **Depends on:** — · **Target:** 2.2.0
