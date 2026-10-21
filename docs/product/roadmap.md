# Roadmap

Date: 2026-10-21. Owner: Product Manager. Format: Now / Next / Later, tied to SemVer minor releases ("stacks").
North-star metric: **share of protected sites with an isolated restore that passed within their target window** ([vision](vision.md), [metrics](metrics.md)).

This is a plan, not a commitment. Items labelled *validated* in a release need real Linux Docker integration evidence ([AGENTS.md](../../AGENTS.md)). Nothing here claims they have it today.

## Overview

| Horizon | Stack | Theme | Status |
| --- | --- | --- | --- |
| Now | 2.1.0 | Trustworthy foundation: performance, worker safety, honest verification, S3 + Object Lock, SSRF, safe upgrades | In flight (branches) |
| Next | 2.2.0 | Safe in-app updates | Planned by owner |
| Next | 2.3.0 | Maintainable codebase | Planned by owner |
| Later | 2.4.0 | Know when something is wrong: alerts, scheduled scrubs, readiness | PM proposal |
| Later | 2.5.0 | Proof on a schedule: restore drills, RPO/RTO | PM proposal |
| Later | 2.6.0 | Agency pack: second copy, client grouping, client reports | PM proposal |
| Later | 2.7+ | Platform reach: arm64, migration/cutover, non-root helper | PM proposal, needs owner decisions |

---

## Now — 2.1.0 "Trustworthy foundation" (in flight)

Work on branches as of 2026-10-21: `perf/api-state-batching`, `fix/worker-lease-drain`, `docs/verification-wording`, `feat/s3-storage`, `fix/probe-url-ssrf`, plus the safe-upgrade system (not yet on a branch in this worktree's view).

| Item | User outcome |
| --- | --- |
| `/api/state` performance + paginated history API | The dashboard stays responsive as history grows |
| Worker SQLite lease + drain on SIGTERM | Restarts and upgrades no longer strand a lock or cut off a running job. The current `worker.lock` needs manual cleanup after an unclean death ([independent-recovery.md](../independent-recovery.md)) |
| Four verification levels in the UI + honest README | Operators see integrity, consistency, isolated restore and application results separately. No single "Verified" badge |
| S3-compatible storage with optional Object Lock | Cheaper storage. Objects the manager cannot delete during the lock period |
| SSRF hardening of probe URLs | Health and public probe URLs cannot be used to reach internal services |
| Safe-upgrade system: versioned migrations with snapshots, upgrade script, signed GHCR images, release manifest | Upgrading cannot silently corrupt or lose state. Rollback is documented and tested. Today `src/db.js` uses ad hoc additive `ALTER TABLE ... ADD COLUMN` without a schema version |

- **Goal:** make the existing product safe to upgrade and honest in what it claims, before adding scope.
- **Success metrics:**
  - 100% of upgrade tests from 2.0.0 old-schema fixtures preserve accounts, factors, servers, sites, policies, backups and verification history (exact row and field comparison).
  - Zero UI or README strings show a merged "Verified" claim (checked by a string test).
  - A snapshot, then a failed migration, then a rollback cycle passes in CI.
  - S3 publish is atomic: a partial upload is never listed as a recovery point (fake-S3 test now; real-provider Linux run before it is called validated).
- **Non-goals:** no new backup capabilities, no dedup, no notification channels, no change to the restore isolation model, and no automatic migration without a pre-migration snapshot.

## Next — 2.2.0 "Safe in-app updates" (planned)

The owner plans: Settings checks GitHub releases, a one-click update through a **host-side systemd updater** (containers keep no Docker socket), a "What's new" modal and safe downgrade.

- **Goal:** let non-expert operators stay current without SSH sessions or risk to data.
- **User outcome:** "I see an update, read what changes, click once, and either it works or it rolls back automatically, with my data unchanged."
- **Success metrics:**
  - Update-path tests (N-1 to N and N-2 to N) pass with an identical state comparison.
  - A forced failure at each updater step rolls back to the previous image and snapshot with no state difference.
  - Signature verification rejects a tampered manifest or image.
  - Measured time from clicking Update to a healthy dashboard on the reference VPS (target set after the first measurement).
- **PM additions recommended for 2.2.0:**
  - **R1: protect the latest backup that passed an isolated restore in retention.** This is a small data-safety change ([backlog PM-06](backlog.md)).
  - The update check must be **opt-in or clearly disclosed**. It is the first outbound call the manager makes (see [open question Q4](open-questions.md)).
- **Non-goals:** no Docker socket in any container, no automatic unattended updates by default, and no downgrade across a non-reversible migration without the pre-upgrade snapshot.
- **Security / upgrade risk: HIGH.** The updater runs as root on the host. It needs a Security Engineer review of the trigger channel (the manager to host-updater interface must not let a dashboard compromise become arbitrary root execution). The update itself must be tested as carefully as the upgrade path.

## Next — 2.3.0 "Maintainable codebase" (planned)

Code restructure, lint/format, release-please.

- **Goal:** make contributions and reviews cheaper without changing behavior.
- **User outcome:** none visible. Faster, safer releases afterward.
- **Success metrics:** `npm run check` and `npm run test:integration` give identical results before and after. No API response shape changes (snapshot tests). Release notes are generated by release-please from conventional commits.
- **Non-goals:** no feature changes, no schema changes, no dependency major upgrades bundled into the restructure.
- **PM addition (parallel, docs/QA only):** R8, a storage-cost benchmark versus restic and Kopia ([backlog PM-19](backlog.md)). It runs on Linux fixtures and publishes the method and raw numbers.

## Later — 2.4.0 "Know when something is wrong" (PM proposal)

- **Goal:** no failure goes unnoticed for long. This closes the biggest gap against Backrest, offen and VolumeVault (all of which can notify).
- **User outcome:** "If a backup fails, a site doesn't restart, a package is corrupt or the manager itself goes quiet, I hear about it in my channel within the hour."
- **Items:** R2 heartbeat ping, R3 scheduled integrity scrubs, R4 notifications (email / webhook / ntfy), R6 readiness score, R5 onboarding to a first passed restore.
- **Success metrics:**
  - In tests, every failure class (backup failed, restart failed / `recovery_required`, scrub failed, storage unreachable, worker stale) produces exactly one notification with secrets redacted.
  - The scheduled scrub covers 100% of retained packages within the configured cycle.
  - Median time from a fresh VPS to a first passed isolated restore is measured in the onboarding walkthrough test (target: under 60 minutes).
- **Non-goals:** no hosted notification relay, no SMS or paid channels, no telemetry, no "health score" that hides individual results.

## Later — 2.5.0 "Proof on a schedule" (PM proposal; strategic headline)

- **Goal:** make recovery evidence continuous rather than on demand, which is the positioning's differentiator.
- **User outcome:** "Every site gets restored into an isolated copy on a schedule I choose. It is torn down automatically, and I get a dated pass or fail with the measured restore time."
- **Items:** R9 scheduled restore drills with resource limits and TTL, R10 per-site RPO/RTO targets and reporting.
- **Success metrics:**
  - Share of sites with a passed drill within their window (north star). Target to be set after 2 releases of data from the owner's install.
  - Drill teardown leaves zero containers, networks or paths after the TTL (Linux integration).
  - The resource-limit breach test aborts cleanly.
- **Non-goals:** no drills on the production source server by default (a designated drill target is required), no outbound network from drills, and no claim beyond the configured checks.
- **Risk:** drills consume target-server resources and run restored application code. Isolation (`networkMode: none` / internal) already exists. Resource limits and TTL are new and need Linux evidence.

## Later — 2.6.0 "Agency pack" (PM proposal)

- **Goal:** make DockNest the tool an agency can show to its clients.
- **Items:** R11 second independent copy with separated delete authority, R13 client grouping and tags, R12 client-facing recovery report.
- **Success metrics:** the second copy is verified by a scheduled scrub on the second target. A test shows the manager credential cannot delete it (S3 Object Lock or a write-only target). The report contains only the selected client's sites, and redaction tests pass.
- **Non-goals:** no multi-tenant client logins (clients don't get accounts), no white-label branding, no billing.

## Later — 2.7+ "Platform reach" (needs owner decisions)

R15 arm64 sources, R14 server-to-server migration through restore and a guided cutover, R16 non-root helper. Online database adapters and dedup storage need the owner's call on Q2 and Q6 in [open-questions.md](open-questions.md).

---

## RICE scoring of new ideas

**Scale.**
- **Reach:** % of active installs that would use or benefit within a quarter (0–100). There is no telemetry and the install base is tiny, so a percentage avoids invented absolute numbers.
- **Impact:** 3 massive, 2 high, 1 medium, 0.5 low, 0.25 minimal, measured against the north star and the P1/P2 jobs.
- **Confidence:** 100 / 80 / 50%.
- **Effort:** team-weeks, including review, tests and docs (Linux integration time included where needed).
- **Score** = R × I × C ÷ E.

**Shared assumptions.**
- (a) Most installs have 2–20 sites and at least one scheduled site.
- (b) No install has outbound alerting today, because none exists in code.
- (c) Effort assumes the 2.3.0 restructure is done.
- (d) Confidence is lowered wherever no user has asked for the feature yet.

| ID | Idea | R | I | C | E | **RICE** | Target | Security-model risk | Upgrade-safety risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Retention also protects the latest backup that passed an **isolated restore** (today only the latest *application*-passed one is protected, `src/artifact-journal.js`) | 60 | 2 | 80% | 0.5 | **192** | 2.2.0 | None | Low: deletes less, may use more storage. Show the extra storage this protection uses |
| R2 | Opt-in heartbeat ping (Healthchecks-style URL) after each scheduler cycle or successful backup, so a dead manager is detected externally | 70 | 2 | 80% | 1 | **112** | 2.4.0 | **Flag:** first user-configured outbound call. Reuse the SSRF guard, opt-in, send no payload | None (additive setting) |
| R3 | Scheduled integrity scrubs (cadence per install or site; reuses `enqueueScrub`, does not stop sources) | 90 | 1 | 100% | 1 | **90** | 2.4.0 | None | None. Watch S3 egress cost |
| R4 | Notifications: SMTP email, generic webhook, ntfy | 90 | 2 | 80% | 2 | **72** | 2.4.0 | **Flag:** stores SMTP/webhook secrets (seal with the master key, include in the recovery kit), outbound egress, message redaction | Low: additive tables. Must survive kit restore and migration |
| R5 | Onboarding: prerequisite checker (root, Python 3, Docker version, arch, disk) + guided "first passed isolated restore" checklist | 100 | 2 | 80% | 3 | **53** | 2.4.0 | None | None |
| R6 | Recovery readiness score per site: explainable, derived from the 4 verification results, last-capture age vs schedule and blockers. Never higher than its weakest required result | 90 | 1 | 80% | 1.5 | **48** | 2.4.0 | **Flag (honesty):** a score must not merge results into a false "green" | None (computed) |
| R7 | In-app updater (owner-planned) | 100 | 2 | 80% | 6 | 27 | 2.2.0 | **HIGH:** host-side root updater, signed artifacts, trigger channel | **HIGH:** the update path itself |
| R8 | Published storage-cost and time benchmark vs restic and Kopia on fixed fixtures | 50 | 0.5 | 80% | 1 | 20 | 2.3.0 (parallel) | None | None |
| R9 | **Scheduled restore drills** on a designated target with CPU, memory and disk limits, a TTL teardown, no egress, and evidence recorded per package | 60 | 3 | 50% | 5 | 18 | **2.5.0 (strategic)** | Medium: runs restored code. Must keep `none`/internal networks and limits | Low: additive policy fields |
| R10 | Per-site RPO/RTO targets with reporting (RPO from last usable capture, RTO from measured drill duration, not capture time) | 50 | 2 | 50% | 3 | 17 | 2.5.0 | None | Low |
| R13 | Client grouping and tags for sites (filter, per-client views) | 30 | 1 | 80% | 2 | 12 | 2.6.0 | Low, unless it grows into per-client RBAC (then HIGH) | Low |
| R11 | Second independent copy: replicate packages to a second target using a put-only or Object-Lock credential, and scrub it on a schedule | 40 | 3 | 50% | 6 | 10 | 2.6.0 | **Flag:** the manager must never hold the delete credential for the copy | Low |
| R12 | Client-facing recovery report (print-ready HTML → PDF) per client and period | 25 | 2 | 50% | 3 | 8 | 2.6.0 | **Flag:** privacy and redaction. Wording must stay honest | None |
| R15 | arm64 source servers (Hetzner CAX, Oracle Ampere, etc.) | 30 | 2 | 50% | 4 | 7.5 | 2.7+ | None | None. Requires arm64 Linux evidence |
| R16 | Non-root constrained helper (sudoers allowlist) | 50 | 1 | 50% | 6 | 4 | 2.7+ | **HIGH:** changes the trust boundary | Medium |
| R14 | Server-to-server migration: restore + guided cutover (DNS/proxy checklist, safety backup, rollback) | 30 | 2 | 50% | 10 | 3 | 2.7+ | **HIGH:** touches production. Replacement is blocked in code today | Medium |

**Where strategy overrides the RICE ranking.** R9 (scheduled drills) ranks 9th by RICE because of its effort and uncertainty, but it is the positioning gap. It is scheduled as the 2.5.0 headline, and R3, R4 and R6 are deliberately placed first because drills depend on them (a drill nobody hears about, or that has no readiness view to land in, delivers little). R7 is the owner's decision and stays in 2.2.0.

## What we are not building (2.x)

- Dedup or incremental engine of our own (see Q6)
- Hosted SaaS or a telemetry backend (see Q1, Q4)
- Kubernetes, Swarm-cluster or Windows-container support
- Automatic production replacement without a validated safety backup and rollback
- Arbitrary user hook scripts discovered from labels (the [architecture review](../research/public-release-architecture-review.md) rejects them)
- Paid notification channels (SMS, PagerDuty-native). A webhook covers them.
