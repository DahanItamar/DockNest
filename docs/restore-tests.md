# Automatic restore tests (ADR, PM-22)

Status: accepted design for 2.9.0. Not implemented yet. Date: 2026-10-26.
Backlog: PM-22 (this design), PM-23 (build), PM-19 (storage report part). Owner answers: Q9 (test server), Q6 (no
incremental backups in 2.9.0).

An automatic restore test restores a site's latest verified backup onto a test server, starts it with no outside
network, checks it, records the result on that backup, and removes everything it created. It answers one question on a
schedule: "would this backup come back if I needed it today?"

Real restore tests count as validated only when the Linux integration test below passes (see AGENTS.md). Until then
the feature ships behind its own "beta" label, like moves did.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Where | A test server the owner picks per site. The site's own (live) server only with an explicit opt-in and a warning. |
| Which backup | The latest backup that is `verified=1` and not in retention. "Run test now" may name another backup. |
| When | Off by default. Cadence daily, weekly (suggested) or monthly, 30 minutes after the site's next scheduled backup. |
| Network | No outside network at all. Single containers: `--network none`. Groups: fresh `--internal` networks with isolated gateway mode, as in today's restore. No published ports. |
| Limits | Per container `--memory` (default 1 GiB, swap equal), `--cpus` (default 1), `--pids-limit 1024`. Time limit per test (default 30 minutes). Free space `size*3 + 1 GiB`. |
| Passed | Every service that ran at capture runs, is Docker-healthy, and still runs after 60 seconds; configured database checks match; the optional internal web check answers 200-399. |
| Clean up | Always, after the checks or at the time limit. Journalled on both sides; survives manager and worker restarts; a detached reaper on the test server is the backstop. |
| Concurrency | One test per test server at a time, never with a backup, restore or move on that server. Backups go first. |
| Evidence | Append-only rows per test, linked to the backup; the backup's `isolatedRestore` and `application` evidence is updated. |
| Alerts | `restore_test.failed`, `restore_test.recovered`, `restore_test.needs_you` through the existing alerts engine (Telegram and email). |
| Storage | 2.9.0 adds a storage report with an honest upper limit for what incremental backups could save. No incremental backups. |
| Schema | Migration 9 `restore-tests`, `compatible: true`, new tables, indexes and triggers only. Radar drafts renumber to 10. |

## Choosing the test server

- Settings hold one `serverId` per site. Any connected server can be chosen.
- If `serverId` is the site's own server, `allowLiveServer` must be true. Turning it on needs an administrator and a
  re-verification within 5 minutes (as for installs). The settings sheet shows: "The test runs next to your live
  sites. It can use up to {memory} and {cpus} CPUs per container for up to {minutes} minutes. Backups on this server
  wait while it runs."
- The chooser always says: "The test server receives a full copy of this site, including its passwords. Pick a server
  you trust as much as the live one." This is true today for a manual restore too.
- A test on the live server never touches live containers: names start `dbm-test-<id12>`, the Compose project label is
  replaced (as the restore already does), restart policy is `no`, and no host port is bound.
- On the live server the memory check is stricter (see limits).

## Which backup and when

- The test uses the newest backup of the site with `verified=1`, no `retention_operations` row and a readable storage
  object. If there is none, no test is created; the site shows "Not tested: no verified backup yet" and the audit log
  records `restore_test.skipped`.
- `next_due_at` is set when tests are turned on: the site's next scheduled backup (`policies.next_run`) plus 30
  minutes, so the test normally checks a fresh backup and tests spread out the way backups do. Without a backup
  schedule it is now plus one cadence period.
- The worker's tick queues a due test only when the site has no queued or running backup, no unfinished move, no
  unfinished test and no deployment hold. Otherwise it waits for the next tick.
- After queueing, `next_due_at` advances by the cadence (1, 7 or 30 days) until it is in the future. A long outage does
  not cause a burst of catch-up tests.
- "Run test now" is allowed for operators and administrators (it is as safe as a manual restore). At most one
  unfinished test per site, and at most 6 manual tests per site per 24 hours.

## Resource limits

- Docker flags on every test container: `--memory M --memory-swap M --cpus C --pids-limit 1024 --restart no`.
  Defaults M = 1 GiB, C = 1. Advanced settings allow M 256 MiB-16 GiB and C 0.25-8.
- Captures already refuse privileged containers, devices, added capabilities and host namespaces
  (`restore_network_plan`), so a test never gets them either.
- Time limit default 30 minutes, allowed 10-120. It covers the whole test from claim to the end of the checks.
  Clean-up runs after it and has its own 10 minute limit.
- "Check space" runs a read-only helper call before anything is copied:
  - free disk at the restore staging root at least `backup.size*3 + 1 GiB` (the `planRestore` rule; the helper
    re-checks extracted size as it does today);
  - `MemAvailable` (from `/proc/meminfo`) at least containers x M on a test server, and at least 2 x containers x M
    on the live server;
  - Docker 28 or newer for grouped sites, same architecture, root SSH (the `planRestore` blockers);
  - no leftovers labelled `docknest.restore-test` from another test.
  Any failure ends the test as failed at "Check space" with one plain reason, before any data moves.

## Network policy

- Restore tests keep the restore's isolation and add nothing: `--network none` for one container; for groups, fresh
  `--internal` bridge networks with `gateway_mode_ipv4/ipv6=isolated`, original aliases, `--dns 127.0.0.1`. No
  published ports. Never the default bridge.
- Unlike a move's test copy, there is no outgoing internet. A restored copy holds live API keys, mail passwords and
  webhook URLs. Without egress it cannot send mail, charge cards, call webhooks or fight the live site for a lock.
- Honest limit: an app that needs an outside service to start (an external database, a licence server, OAuth at
  boot) fails the test. The failure reason says "The copy may need a service outside the server; restore tests run
  without internet." That is a real finding about recoverability, not a bug in the test.

## What "passed" means

Checks run in order. The first failure fails the test at that step.

| Check | Applies to | Passes when |
|---|---|---|
| Backup authentic | all | Full AES-256-GCM authentication and stored SHA256 match (existing upload path). |
| Package complete | all | The helper's artifact inventory matches the manifest before any Docker load or extraction (existing `unpack_verified`). |
| Static files | static sites | Restored tree digest equals the captured `staticFiles` digest (existing). |
| Containers running | Docker sites | Every service that ran at capture is running; services stopped at capture stay stopped. |
| Docker health | services with a healthcheck | `healthy` within 120 seconds (existing `health()`). |
| Still running | Docker sites | All of the above still hold 60 seconds later. Catches crash loops, since restart is `no`. |
| Database checks | configured services | Existing `data_checks` row counts and SQLite proofs match the values recorded at capture. |
| Internal web check | optional, Docker sites | GET `http://127.0.0.1:{port}{path}` inside the chosen container's network namespace returns 200-399 within 10 seconds. |

- The web check runs the helper's own Python inside the container's network namespace with
  `nsenter --net --target <pid> --setuid 65534 --setgid 65534`. No tool is needed inside the image and no port is
  opened. It reads at most 64 KiB, follows no redirects and stores only the status code and time, never the body.
  `nsenter` is part of util-linux; if it is missing the check is `skipped` with that reason and does not fail the test.
- The port defaults to the first web port `web_hints` finds; the owner can set service, port and path.
- Each check is stored as `passed`, `failed`, `skipped` or `not-configured`.
- What a pass cannot prove: logins, payments, emails, background jobs, anything that needs the internet, or data
  beyond the configured checks. The result card says: "Your site started from this backup and passed {n} checks.
  It does not prove every page works."
- A test with only container checks records `application: not-tested`, exactly as `recovery-verification.md` defines.

## Steps (the job timeline)

| Step key | Label | What happens |
|---|---|---|
| `check_space` | Check space | Read-only preflight above. |
| `copy_backup` | Copy backup | Authenticate the package and stream it into the staging root (existing `uploadBackupTo`). |
| `restore_copy` | Restore copy | Verify inventory, extract mounts, load images, create networks and containers. |
| `start_containers` | Start containers | Start in the captured restart order. |
| `check_health` | Check health | Health, stability, database and web checks. |
| `clean_up` | Clean up | Remove everything the journal lists. Always runs, also after a failure or cancel. |

Restore duration (`restore_seconds`) runs from the start of `copy_backup` to the end of `start_containers` with
healthy containers. It excludes queue time, checks and clean-up. PM-24 uses it as RTO.

## Clean-up that survives restarts

Two journals, the same pattern as moves (`site_move_steps` plus the helper's `resources.json`):

- Manager side: `restore_test_steps` rows. A step is written `running` before its effect and `done` after it.
- Test server side: `/var/lib/docknest/restore-tests/<testId>/resources.json` (root, 0700). The helper writes each
  network, container, image, tag change and path before it creates it, like `journal_resource`.
- Images: before `docker load`, the helper records the image IDs present and the IDs behind every `repo:tag` named in
  `images.tar`. After the load it points each changed tag back at its old ID at once, so a live server's
  `myapp:latest` never moves. Only IDs that were not present before are journalled as test-only.
- Every container and network also carries the label `docknest.restore-test=<testId>`.

Teardown (`restore-test-teardown`, idempotent):

1. `docker rm -f` containers with the label.
2. `docker network rm` journalled networks that still have the label.
3. `docker image rm` (never `-f`) each test-only image. An image a non-test container now uses is kept and reported.
   Tags that did not exist before are removed only if they still point at the test image.
4. Remove the staging root (only under `/var/lib/docker-backup-manager/restore/`) and the journal directory (only
   under `/var/lib/docknest/restore-tests/`), checked with symlinks resolved.
5. `restore-test-status` must then report nothing left. Only then is `clean_up` done.

Restart and failure paths:

- Worker restart: `test_running` jobs are not touched by the existing "mark running jobs recovery_required" line. A
  new startup step turns them into `test_cleanup`. That status holds its server in `claimJob` like a running job and
  is claimed before anything else on that server. Its claim only runs teardown and status.
- Reaper: at `restore_copy` the helper copies itself to the journal directory and starts it detached (`setsid`) to
  run teardown at the deadline plus 10 minutes. It covers a manager that is down or rolled back. Containers have
  restart `no`, so a test server reboot leaves them stopped; the next manager tick removes them.
- Clean-up that fails is retried after 5, 15 and 60 minutes. Then the job becomes `recovery_required` (the server stays
  blocked, as for any unknown remote state), the test's `cleanup` becomes `failed`, and `restore_test.needs_you` fires.
  The existing acknowledge route accepts it only after `restore-test-status` confirms nothing is left.

## Concurrency and fairness

- Jobs: type `restore-test`, statuses `test_queued`, `test_running`, `test_cleanup`. Releases before 2.9.0 claim only
  `queued` and `move_queued`, so they never start a test (the moves precedent).
- `details.targetServerId` is the test server, so the existing `claimJob` rule keeps one job per server: a test never
  runs alongside a capture, restore, install or move on that server. `test_running` and `test_cleanup` join the
  statuses that occupy a server.
- Order: `claimJob` sorts `restore-test` jobs after every other queued job, then by `created_at`. A test is also not
  claimed when an enabled backup policy of a site on that server has `next_run` within the test's time limit.
- One unfinished test per site (partial unique index). Tests for different sites on one test server queue in order.
- A test does not block backups of its own site on the live server, unless the live server is the test server.
- Retention: `deletionBlocked` also refuses a backup with an unfinished test or unfinished clean-up. This is the
  test's lease on the package.

## Evidence and history

- Each test is one `restore_tests` row. `result`, `failed_step`, `reason`, `checks`, `restore_seconds` and
  `total_seconds` are written once; a trigger refuses later changes and refuses deletes. Steps are never deleted.
- A deleted backup keeps its tests: `backup_id` becomes NULL and `backup_captured_at` stays.
- On a pass or a backup-side failure the worker also calls `recordVerification` for `isolatedRestore` and
  `application` (method "automatic restore test"), so the append-only `backup_verification_history` keeps it.
- Failures caused by the test server, not the backup (unreachable, no space, too little memory, an interrupted
  transfer), fail the test but write no verification evidence on the backup.
- `reason` is one plain sentence, at most 300 characters, scrubbed with the move journal's secret-looking-data check.
  No environment values, paths of the user's data, logs or response bodies.

## Alerts

New events in `src/alerts/events.js`, detected by `detect.js` from `restore_tests` with a new cursor field `tests`
(missing means "start now", so no history is replayed):

| Event | When | Message |
|---|---|---|
| `restore_test.failed` | A test ended `failed` | `Restore test failed: {site} on {server} at {time}. Open DockNest to see why.` |
| `restore_test.recovered` | A pass after the previous finished test failed | `Restore test passed again: {site} on {server} at {time}.` |
| `restore_test.needs_you` | Clean-up failed after its retries | `Restore test could not clean up on {server}. Open DockNest to check it.` |

Keyed by test id (occurrence events, never repeated). `{server}` is the test server. Site and server rules match
(`targetServerId` is set). Messages carry names only, as the alert policy requires. No webhooks.

## Audit events

`restore_test.settings` (changed field names and values; no secrets exist in settings), `restore_test.enqueue`
(actor, trigger, backup), `restore_test.skipped`, `restore_test.passed`, `restore_test.failed` (failed step),
`restore_test.cancelled`, `restore_test.cleaned` (counts), `restore_test.cleanup_failed`,
`restore_test.recovery_acknowledged`. Viewing the storage report is read-only and not logged.

## API contract

All routes need a session; changes need CSRF. Administrator only: settings changes. Operators: read, run, cancel.

`GET /api/sites/:id/restore-tests` → the site's card:

```json
{
  "settings": { "enabled": false, "cadence": "weekly", "serverId": null, "allowLiveServer": false,
    "timeLimitMinutes": 30, "memoryMb": 1024, "cpus": 1,
    "probe": null, "nextDueAt": null, "skipReason": null },
  "last": { "id": "uuid", "result": "passed | failed | cancelled", "finishedAt": "ISO",
    "restoreSeconds": 84, "failedStep": null, "reason": null, "serverName": "test-srv" },
  "active": { "id": "uuid", "state": "queued | running | cleaning", "step": "copy_backup" },
  "items": [ { "id": "uuid", "backupId": "uuid", "backupCapturedAt": "ISO", "trigger": "schedule | manual",
    "result": "passed", "finishedAt": "ISO", "restoreSeconds": 84 } ],
  "next": "cursor or null"
}
```

`probe` is `{ "service": "container name", "port": 8080, "path": "/" }` or null. `last` and `active` may be null.

`PUT /api/sites/:id/restore-tests/settings` takes the `settings` fields above (without `nextDueAt`, `skipReason`).
Errors: 400 `INVALID` (zod details), 409 `TEST_SERVER_REQUIRED` (enabled without a server), 409
`LIVE_SERVER_NOT_ALLOWED`, 403 `REVERIFY_REQUIRED` (turning on `allowLiveServer`), 409 `PROBE_STATIC` (probe on a
static site). Turning tests off does not cancel a running test.

`POST /api/sites/:id/restore-tests` body `{ "backupId": "uuid" }` (optional) → 202 `{ "id", "jobId" }`. 409
`TEST_ACTIVE`, `NO_VERIFIED_BACKUP`, `SITE_BUSY` (moving or deployment hold), `NO_TEST_SERVER`; 429 `TOO_MANY_TESTS`.

`GET /api/restore-tests/:id` → full detail:

```json
{ "id": "uuid", "siteId": "uuid", "backupId": "uuid", "backupCapturedAt": "ISO", "serverId": "uuid",
  "serverName": "test-srv", "trigger": "manual", "state": "queued | running | cleaning | finished | needs_cleanup",
  "result": null, "failedStep": null, "reason": null, "restoreSeconds": null, "totalSeconds": null,
  "createdAt": "ISO", "startedAt": "ISO", "finishedAt": null, "deadlineAt": "ISO",
  "cleanup": "pending | done | failed | acknowledged",
  "limits": { "memoryMb": 1024, "cpus": 1, "timeLimitMinutes": 30 },
  "steps": [ { "step": "check_space", "label": "Check space", "state": "pending | running | done | failed | skipped",
    "startedAt": null, "finishedAt": null, "detail": null } ],
  "checks": [ { "name": "Containers running", "kind": "running | health | stable | database | sqlite | http | static-files",
    "target": "web", "status": "passed | failed | skipped | not-configured", "detail": "HTTP 200 in 140 ms" } ] }
```

A failed test shows `failedStep` and `reason`, and the failed step carries the same sentence in `detail`.

`POST /api/restore-tests/:id/cancel` → 202. Queued tests end `cancelled` at once; running ones stop the helper call,
then clean up. `POST /api/restore-tests/:id/cleanup` retries clean-up of a `needs_cleanup` test (administrator).
Acknowledging uses the existing `POST /api/jobs/:id/recovery`.

`GET /api/backups` and backup detail add `restoreTest: { "status": "passed | failed | not-tested", "testId", "testedAt" }`
from the newest finished, non-cancelled test of that backup.

`GET /api/storage/report` → see the next section.

## Storage report (Q6 / PM-19)

The report helps the owner decide later whether incremental backups are worth building. It measures what is stored
and gives an upper limit for the saving, clearly labelled as an estimate.

```json
{ "generatedAt": "ISO",
  "storages": [ { "id": "local | target uuid", "name": "Local disk", "packages": 42, "bytes": 0, "capacityBytes": null } ],
  "sites": [ { "siteId": "uuid", "name": "shop", "packages": 7, "bytes": 0, "newestBytes": 0,
      "growthPerBackupBytes": 0, "estimate": { "upToBytes": 0, "upToPercent": 0 } } ],
  "totals": { "packages": 0, "bytes": 0, "estimateUpToBytes": 0 },
  "method": "plain sentence shown under the numbers" }
```

- Bytes are the stored `backups.size` of current (not deleted) packages. Storage is taken from the backup path
  reference (`sftp:<id>:`, `s3:<id>:` or a local path). Capacity comes from the existing storage capacity call, when
  the destination reports one.
- Estimate per site, packages sorted by capture time: `needed = max(largest package, first package + sum of every
  increase between consecutive packages)`; `upTo = stored - needed`, never below zero.
- This treats only growth as new data. It is the best case. It cannot know which bytes changed inside an encrypted,
  compressed package: a database rewritten in place at the same size counts as unchanged here but not in reality. It
  also ignores dedup between sites, an incremental tool's own index and compression differences. The card says: "Up
  to {x} might be saved. This is an upper limit from package sizes only; DockNest cannot see inside encrypted
  backups."
- Computed on request from metadata only. No storage reads, no server calls, nothing stored. No new dependencies.

## Data model (migration 9 `restore-tests`, `compatible: true`)

New objects only. Nothing is altered, no rows are inserted.

- `restore_test_settings(site_id PK → sites, enabled 0/1 DEFAULT 0, cadence CHECK daily|weekly|monthly DEFAULT
  'weekly', server_id → servers NULL, allow_live_server 0/1 DEFAULT 0, time_limit_minutes CHECK 10..120 DEFAULT 30,
  memory_mb CHECK 256..16384 DEFAULT 1024, cpus REAL CHECK 0.25..8 DEFAULT 1, probe TEXT NULL CHECK length <= 512,
  next_due_at TEXT, skip_reason TEXT, updated_at, updated_by)`. No row means off.
- `restore_tests(id PK, site_id → sites, backup_id → backups ON DELETE SET NULL, backup_captured_at, server_id →
  servers, job_id → jobs, trigger CHECK schedule|manual, result CHECK passed|failed|cancelled NULL, failed_step,
  reason CHECK length <= 300, restore_seconds, total_seconds, checks CHECK length <= 8192, limits, cleanup CHECK
  pending|done|failed|acknowledged, cleanup_attempts, deadline_at, created_by, created_at, started_at,
  finished_at)`.
- `restore_test_steps(test_id → restore_tests, step CHECK six keys, state, started_at, finished_at, detail CHECK
  length <= 500, PRIMARY KEY(test_id, step))`.
- Indexes: unique `restore_tests(site_id) WHERE result IS NULL`; `(site_id, created_at, id)` for keyset paging;
  `(backup_id, created_at)`; `restore_test_settings(next_due_at) WHERE enabled = 1`.
- Triggers: refuse `DELETE` on `restore_tests` and `restore_test_steps`; refuse changing `result`, `failed_step`,
  `reason`, `checks`, `restore_seconds`, `total_seconds` once `result` is set.

## Upgrade safety

- Upgrading from 2.8.x runs migration 9 after the normal pre-upgrade snapshot. Tests are off for every site because
  no settings row exists. Nothing changes for existing backups, restores, moves or alerts. Existing alert rules do not
  gain the new events; the owner ticks them.
- The compatibility floor does not move, so rolling back to 2.8.x still opens the database. 2.8.x ignores
  `test_*` jobs and the new tables. Finish or cancel running tests before rolling back; a test caught mid-run is
  removed by its reaper on the test server, and resumes clean-up after upgrading again.
- The helper version increases. As with every helper change, installed boot recovery copies show "outdated" until
  reinstalled.
- Upgrade fixtures (PM-01) gain a 2.8.2 database; the test asserts exact preservation and that migration 9 is
  idempotent.

## Security review points

1. Secrets: the decrypted package (with inspect configuration and environment) reaches the test server, as in a
   manual restore. Staging is root 0700 and removed by teardown. Settings, steps, checks, reasons, audit details and
   alerts hold no secret values; the probe stores no body.
2. Isolation: no egress, no published ports, no privileged settings, restart `no`, unique names and labels, Compose
   project label replaced. Live server only with administrator opt-in and re-verification.
3. Image tags on the test server are restored right after `docker load`, so a test never changes what a later
   `docker compose up` on that server would run.
4. Resource abuse: memory, swap, CPU and pids limits per container, a time limit, one test per server, a memory
   precheck, at most daily scheduling and 6 manual runs per site per day.
5. Probe: unprivileged uid inside the container's namespace, loopback only, size and time capped, no redirects.
6. Clean-up: label and journal must agree before anything is removed; fixed roots only; never `docker image rm -f`;
   failure leaves the server blocked (`recovery_required`) and alerts, rather than continuing on unknown state.
7. Reaper: a copy of the reviewed helper only, root-owned 0700, runs one teardown and exits.

Sign-off before PM-23 merges: Security Engineer and Reality Checker (per PM-22).

## Linux integration test plan

`scripts/integration-restore-test.js`, run in the `linux-integration` CI job on real Docker 28+:

- Single container with a healthcheck: passes; `HostConfig.Memory`, `NanoCpus`, `PidsLimit` match the settings;
  `NetworkMode` is `none`; no port bindings.
- Grouped Compose site (web + PostgreSQL with a row-count check and a web check on `/`): passes; networks are
  `Internal`; a container cannot reach an outside address or resolve a public name.
- Static site: passes on the digest.
- Failure: a fixture whose container exits after 20 seconds fails at "Check health" with the "Still running" check,
  and is cleaned up.
- Live-server opt-in on the same host as a running fixture site: the live containers, their tags and ports are
  unchanged afterwards.
- Restarts: kill the worker during `restore_copy`; the restarted worker cleans up. Stop the manager past the deadline;
  the reaper cleans up.
- After every case: no container or network with the label, the image ID set and every tag equal to before, no
  staging or journal path, `restore-test-status` reports nothing left.

Not "validated" until all cases pass in CI on Linux.

## QA plan

- Unit and API (node:test): migration 9 from a 2.8.2 fixture, idempotent, floor unchanged; triggers refuse edits and
  deletes; `claimJob` ordering and server blocking with `test_*` statuses; scheduler due times, cadence steps, skips;
  `deletionBlocked` lease; settings validation, roles, re-verification, rate limit; alerts detection, cursor and
  messages; storage estimate maths with growing, shrinking and single-package sites.
- Python (`remote/test_restore_tests.py`): journal written before create, teardown idempotent and label-gated, tag
  restore, path roots, probe limits, status output.
- Browser suites: settings sheet (including the live-server warning), Run test now, step timeline in each state,
  failed test with step and reason, per-backup Tested state, storage report, phone width, light and dark.
- Design review against [DESIGN.md](design/DESIGN.md): `StatusLabel` states, Tabler icons and tokens, no emoji.

## Implementation PRs

1. Engine and helper: migration 9, job statuses and `claimJob`, worker steps, startup clean-up, lease, helper
   operations (`restore-test-check`, `restore-test-prepare`, `restore-test-run`, `restore-test-teardown`,
   `restore-test-status`, reaper), Python tests, Linux integration script. Security-critical review.
2. API, scheduler, alerts and audit events, with API tests.
3. UI: site settings, run now, timeline, backup Tested state, failed details. Browser tests and design review.
4. Storage report (API and card) and docs: README, `alerts.md`, `recovery-verification.md`, `upgrading.md`, release
   notes.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the design and trade-offs, and
[Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md)
for isolation, secrets, abuse limits and clean-up failure handling.
