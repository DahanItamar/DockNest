# Automatic restore tests (ADR, PM-22)

Status: accepted design for 2.9.0. Implemented in 2.9.0; out of beta since 2.13.1. Date: 2026-10-26.
Backlog: PM-22 (this design), PM-23 (build), PM-19 (storage report part). Owner answers: Q9 (test server), Q6 (no
incremental backups in 2.9.0). Release order: restore tests are 2.9.0; the radar moves to 2.10.0.

An automatic restore test restores a site's latest verified backup onto a test server, starts it, checks it, records
the result, and removes everything it created. It answers one question on a schedule: "would this backup come back if
I needed it today?"

Real restore tests count as validated only when the Linux integration test below passes (see AGENTS.md). Until then
the feature ships with its own "beta" label, like moves did. It left beta in 2.13.1 after real-site validation (see
[acceptance.md](acceptance.md)).

## Decisions at a glance

| Topic | Decision |
|---|---|
| Where | A test server the owner picks per site. The site's own (live) server only with an explicit opt-in and a warning. |
| Which backup | The latest backup that is `verified=1` and not in retention. "Run test now" may name another backup. |
| When | Off by default. Daily, weekly (suggested) or monthly, 30 minutes after the site's next scheduled backup. |
| Network | No internet by default (`--network none` or fresh `--internal` isolated networks). Admin-only "Allow internet" in Advanced: rules inside each copy's own network namespace block mail, the metadata service and this server before the copy gets a route out. No published ports. |
| Limits | Presets or a custom number: memory per container (default 1 GB, swap equal), CPUs per container (default 1), time limit (default 30 minutes); pids 1024, log size. Free space `size*3 + 1 GiB`, re-checked at step changes. Disk is not capped. |
| Passed | Services that ran at capture run, are Docker-healthy and still run after 60 seconds; configured database checks match; the optional internal web check answers 200-399. |
| Results | `passed`, `failed` (the backup did not come back), `couldnt_run` (the test server or a test limit stopped it), `cancelled`. |
| Worker | A ticked step machine like moves. Only the copy and restore steps hold the worker for long; health waits are polled across ticks. |
| Clean up | Always, after the checks or at the time limit. Journalled on both sides; survives manager and worker restarts; a reaper on the test server is the backstop. |
| Concurrency | One test per test server; never with a backup, restore, install or move there. Backups go first. A stuck clean-up blocks only the test server, never the site. |
| Evidence | Append-only rows per test. Backup evidence only for backup-side results, never downgrading another method's evidence. |
| Alerts | `restore_test.failed`, `restore_test.couldnt_run`, `restore_test.recovered`, `restore_test.needs_you` (Telegram and email). |
| Storage | A storage report with a rough best-case estimate of what incremental backups could save. No incremental backups. |
| Schema | The next free migration number at merge time (currently 9), `compatible: true`, new objects only. |

## Choosing the test server

- Settings hold one `serverId` per site. Any connected server can be chosen.
- If `serverId` is the site's own server, `allowLiveServer` must be true. Turning it on needs an administrator and a
  re-verification within 5 minutes (as for installs). The sheet shows: "The test runs next to your live sites. It can
  use up to {memory} and {cpus} CPUs per container for up to {minutes} minutes. Backups on this server wait while it
  runs."
- The chooser always says: "The test server receives a full copy of this site, including its passwords. Pick a server
  you trust as much as the live one." This is already true for a manual restore.
- A test on the live server never touches live containers: names start `dbm-test-<id12>`, the Compose project label is
  replaced (as the restore already does), restart policy is `no`, and no host port is bound.
- Sites whose backup excludes paths marked `requiredForRestore` (external storage) are skipped with the reason "This
  site needs external storage that a restore test cannot attach." Reviewed read-only external mappings are out of scope
  for 2.9.0.

## Which backup and when

- The test uses the newest backup of the site with `verified=1`, no `retention_operations` row and a readable storage
  object. If there is none, no test is created; the site shows "Not tested: no verified backup yet" and the audit log
  records `restore_test.skipped`.
- `next_due_at` is set when tests are turned on: the site's next scheduled backup (`policies.next_run`) plus 30
  minutes, so a test normally checks a fresh backup and tests spread out the way backups do. Without a backup schedule
  it is now plus one cadence period.
- The worker's tick queues a due test only when the site has no queued or running backup, no unfinished move, no
  unfinished test and no deployment hold. Otherwise it waits for the next tick.
- After queueing, `next_due_at` advances by the cadence (1, 7 or 30 days) until it is in the future. A long outage does
  not cause a burst of catch-up tests.
- "Run test now": administrators and operators (as safe as a manual restore), at most one unfinished test per site and
  6 manual tests per site per 24 hours. Settings stay administrator-only.

## Resource limits

- Every test container gets `--memory M --memory-swap M --cpus C --pids-limit 1024 --restart no` and
  `--log-driver local --log-opt max-size=10m --log-opt max-file=3`.
- Each limit offers presets and a Custom value the administrator types. DockNest stores the number, never a preset
  name, and refuses anything else with a plain validation error (the engine, the database CHECKs and the helper all
  enforce the same ranges):

  | Limit | Presets | Custom | Default |
  |---|---|---|---|
  | Time limit | 15, 30, 60, 120 minutes | a whole number from 10 to 120 minutes | 30 minutes |
  | Memory per container (M) | 512 MB, 1 GB, 2 GB, 4 GB, 8 GB | a whole number from 256 to 16384 MB | 1 GB (1024 MB) |
  | CPU per container (C) | 0.5, 1, 2, 4 | 0.5 to 16 in steps of 0.25 | 1 |

  At "Check space" C is also refused above the test server's `nproc`, with a plain reason ("The test server has 2
  CPUs, so it cannot give each container 4. Lower the CPU limit.").
- Captures already refuse privileged containers, devices, added capabilities and host namespaces
  (`restore_network_plan`), so a test never gets them either.
- The time limit runs from claim to the end of the checks. Clean-up has its own 10 minutes.
- Disk is not capped. Docker has no portable per-container disk quota for bind mounts. Instead:
  - "Check space" requires free space at the staging root of `backup.size*3 + 1 GiB` (the `planRestore` rule; the
    helper re-checks extracted size as it does today);
  - free space (staging and the Docker root) is re-checked at each step change: before the containers start and at
    the end of the health checks; below 1 GiB the test stops its containers and ends `couldnt_run` ("The test server
    ran low on disk."). There is no polling loop for disk (owner decision: event-driven checks only);
  - the log limits (10 MB x 3 per container) cap what logs can take.
  - Remaining risk: between two step changes a copy can still write into its restored bind mounts or writable layer
    until the time limit. A very fast writer could fill the disk of the test server before the next check. The
    preflight reserve (`size*3 + 1 GiB`), the time limit and choosing a test server that is not the live server limit
    this; it is documented on the live-server warning.
- "Check space" also requires `MemAvailable` (from `/proc/meminfo`) of at least containers x M (2 x on the live
  server), Docker 28+ for grouped sites, the same architecture, root SSH, and no leftovers labelled
  `docknest.restore-test`. A miss ends the test `couldnt_run` at "Check space" with one plain reason.

## Network policy

- Default: the restore's isolation, unchanged. `--network none` for one container; for groups, fresh `--internal`
  bridge networks with `gateway_mode_ipv4/ipv6=isolated`, original aliases, `--dns 127.0.0.1`. No published ports.
  Never the default bridge.
- Why: a restored copy holds live API keys, mail passwords and webhook URLs. Without internet it cannot send mail,
  charge cards, call webhooks or fight the live site for a lock.
- An app that needs an outside service to start (an external database, a licence server, OAuth at boot) fails with
  "The copy may need a service outside the server; restore tests run without internet."
- **Allow internet** (Advanced, administrator only with re-verification, off by default). Still no published ports.
  The warning: "The copy runs with your live keys and passwords. With internet it can call webhooks, payment and other
  APIs, take jobs from shared queues (for example Redis or SQS workers), and run scheduled jobs once. Outgoing mail on
  the standard mail ports (25, 465, 587, 2525), the cloud metadata service and this server's own addresses are
  blocked; mail sent through an HTTP API is not."
- Fail-closed by construction (owner decision, no polling): every copy is created on the fresh internal isolated
  networks only, exactly as without internet (a single container gets one such network), so it has no route out. The
  helper hooks the start of each restart level: right after `docker start`, inside that container's own network
  namespace (`nsenter --net=<SandboxKey>`, the host's `iptables` and `ip6tables`, `OUTPUT` chain) it inserts REJECT
  rules for TCP 25/465/587/2525, `169.254.169.254` (IPv4) and `fd00:ec2::254` (IPv6), and every address of this
  server (all interfaces, so also the Docker gateway of the egress network; loopback and link-local stay usable). It
  verifies each rule once with `-C` (an event, not a loop) and only then connects the container to the test's own
  non-internal egress bridge (`dbm-test-<id12>-egress`, never the default bridge). Services stopped at capture never
  start, so they never get egress.
- Host firewalld or ufw reloads, `iptables -F` on the host and Docker's own host rules cannot remove rules that live
  in the copy's namespace; they disappear only with the container. Teardown therefore has no firewall rules to
  remove. Test containers get `--cap-drop NET_ADMIN`, so a copy cannot change its own rules.
- Allow internet is refused with a plain reason (and the test can run without internet) when a container adds
  `NET_ADMIN`, `NET_RAW`, `SYS_ADMIN` or `ALL`, is privileged, or shares the host's or another container's network,
  or when the test server lacks `nsenter`, `iptables` or `ip6tables`. If inserting or verifying any rule fails, the
  container is stopped before it reaches the egress network and the test ends `couldnt_run`.
- `restore-test-mail-check` checks the rules in each running copy on request; nothing re-checks them periodically.
- Evidence records `internet: true`; the result reads "Passed (tested with internet)".

## What "passed" means

Checks run in order. The first failure ends the test at that step.

| Check | Applies to | Passes when |
|---|---|---|
| Backup authentic | all | Full AES-256-GCM authentication and stored SHA256 match (existing upload path). |
| Package complete | all | The artifact inventory matches the manifest before any Docker load or extraction (existing `unpack_verified`). |
| Static files | static sites | Restored tree digest equals the captured `staticFiles` digest (existing). |
| Containers running | Docker sites | Every service that ran at capture is running; services stopped at capture stay stopped. |
| Docker health | services with a healthcheck | `healthy` within 120 seconds (existing `health()`). |
| Still running | Docker sites | All of the above still hold 60 seconds later. Catches crash loops, since restart is `no`. |
| Database checks | configured services | Existing `data_checks` row counts and SQLite proofs match the values recorded at capture. |
| Internal web check | optional, Docker sites | GET `http://127.0.0.1:{port}{path}` in the chosen container's network namespace returns 200-399 within 10 seconds. |

- The web check runs `nsenter --net=<SandboxKey> setpriv --reuid 65534 --regid 65534 --clear-groups
  --no-new-privs python3 -I -c '<inline probe>'`, only while Docker reports the container running; the namespace
  comes from Docker's sandbox path, never from a PID that could be reused. No tool is needed in the image and no port is opened. It reads at
  most 64 KiB, follows no redirects and stores only the status code and time. If `nsenter` or `setpriv` (util-linux)
  is missing, the check is `skipped` with that reason.
- The port defaults to the first web port `web_hints` finds; the owner can set service, port and path.
- Each check is stored as `passed`, `failed`, `skipped` or `not-configured`.
- Test-side, not backup-side (`couldnt_run`): the container was `OOMKilled`, a pids or memory limit was hit, the disk
  check fired, the time limit ran out, the test server was unreachable or full, or (with internet) the mail block
  could not be set inside the copy. The card says, for example, "Test couldn't finish: memory limit. Raise it in Advanced."
- A pass cannot prove logins, payments, emails, background jobs, anything that needs the internet (by default), or
  data beyond the configured checks. The card says: "Your site started from this backup and passed {n} checks. It does
  not prove every page works."

## Steps and the worker

| Step key | Label | What happens | Holds the worker |
|---|---|---|---|
| `check_space` | Check space | Read-only preflight above. | Seconds |
| `copy_backup` | Copy backup | Authenticate and stream the package to the staging root (existing `uploadBackupTo`). | The transfer time |
| `restore_copy` | Restore copy | Verify inventory, extract mounts, load images, create networks and containers. | Extraction and load |
| `start_containers` | Start containers | Start in the captured restart order. | Seconds |
| `check_health` | Check health | Health, stability, database and web checks, polled across ticks. | Seconds per poll |
| `clean_up` | Clean up | Remove everything the journal lists. Always runs, also after a failure or cancel. | Seconds to minutes |

- The worker is serial (`src/worker-loop.js`). Tests therefore run as a ticked step machine like moves
  (`src/restore-tests/engine.js`): `tickRestoreTests()` runs each tick, every server-touching step is one short
  `restore-test` job, and waits (health, stability) are polls on later ticks that release the worker in between.
  Between polls the `check_health` job rests in `test_waiting` (never claimed) and the tick queues it again when the
  next poll is due, so a test leaves one job row per step.
- Honest effect: while `copy_backup` and `restore_copy` run, other sites' backups wait for the worker, as with a manual
  restore today. The copy grows with package size: a 5 GB package takes minutes, a 50 GB site can hold the worker for
  about an hour. The waits in `check_health` do not delay other servers.
- `cancel_requested` on the test row is polled between steps and inside long helper calls, as moves do. The current
  step stops, then clean-up runs. The result is `cancelled`.
- `restore_seconds` runs from the start of `copy_backup` to healthy containers at the end of `start_containers`,
  excluding queue and tick gaps. PM-24 uses it as RTO.

## Clean-up that survives restarts

Two journals, the move pattern (`site_move_steps` plus the helper's `resources.json`):

- Manager side: `restore_test_steps` rows. A step is written `running` before its effect and `done` after it.
- Test server side: `/var/lib/docknest/restore-tests/<testId>/resources.json` (root, 0700). The helper writes each
  network, container, image, tag change, firewall rule and path before creating it, like `journal_resource`.
- Images: containers are created from snapshot image IDs, never tags. Defensively, before `docker load` the helper
  records the IDs present and the ID behind every `repo:tag` in `images.tar`, then points any changed tag back at
  its old ID right after the load. Only IDs not present before are journalled as test-only.
- Every container and network carries the label `docknest.restore-test=<testId>`.

Teardown (`restore-test-teardown`, idempotent):

1. `docker rm -f` containers with the label (their namespaces, and with them any in-copy rules, go too). Any host
   rule carrying the test's comment is removed as well, although tests add none.
2. `docker network rm` journalled networks that still have the label.
3. `docker image rm` (never `-f`) each test-only image. One a non-test container now uses is kept and reported. A
   tag that did not exist before is untagged on its own only when it still points at the test image and that image
   has other tags; otherwise removing the image by ID takes the tag with it, and a kept image keeps its only name.
4. Remove the staging root (always this test's `/var/lib/docker-backup-manager/restore/<testId>`, journalled or not)
   and the journal directory (only under `/var/lib/docknest/restore-tests/`), with symlinks resolved.
5. Stop this test's reaper (an event, no polling): its PID and kernel start time are journalled, and SIGTERM goes
   only to a process whose command line is this test's `reaper.py` and whose start time matches, so a reused PID is
   never signalled. The reaper exits at once on SIGTERM without acting. A reaper that is already gone is fine, so
   teardown stays idempotent. Then remove the journal.
6. `restore-test-status` must then report nothing left. Only then is `clean_up` done.

Restart and failure paths:

- Worker restart: the startup line that marks `running` jobs `recovery_required` does not match test jobs. A new
  startup step (`recoverInterruptedRestoreTests`) fails each `test_running` job; a test whose step was interrupted
  ends `couldnt_run` ("DockNest restarted during this step, so the test stopped.") with `cleanup='pending'` when
  anything reached the server, and the next tick runs teardown first on that server. An interrupted clean-up runs
  again at once.
- Reaper: at `copy_backup` (in `restore-test-prepare`, before any plaintext reaches the server) the manager sends the
  reaper source, the reviewed helper itself (as `install-boot-recovery` does); the helper writes it into the journal
  directory (0700) and starts it in a new session (`python3 -I reaper.py`, operation `restore-test-reap`). It has one
  timer and no periodic work: it sleeps until the deadline plus the manager's clean-up time (10 minutes, sent as
  `grace`), and then runs teardown once only if the
  journal directory is still there (the manager did not finish), and exits.
- Reaper and logind: a new session survives the SSH channel closing, but systemd-logind with `KillUserProcesses=yes`
  kills every process of the SSH login session when it ends. Where systemd runs, the reaper is therefore started with
  `systemd-run --scope` (its own transient scope outside the session); if `systemd-run` is missing or refuses, it falls
  back to the plain new session. On such a host without `systemd-run`, a reaper may not survive the SSH session; the
  manager's own clean-up and its retries still run. It covers a manager that is down or rolled back. It
  does not survive a reboot of the test server; containers have restart `no`, so they stay stopped, and the next
  manager tick cleans up.
- Clean-up that fails is retried after 5, 15 and 60 minutes. Then the test's `cleanup` becomes `failed` (state
  `needs_cleanup`) and `restore_test.needs_you` fires. The test server stays blocked; the site does not.
- `POST /api/jobs/:id/recovery` gets a `restore-test` branch: it calls `restore-test-status` and acknowledges only when
  nothing is left (`cleanup='acknowledged'`).

## Concurrency and fairness

- Jobs: type `restore-test`, statuses `test_queued`, `test_running` and `test_waiting`. Releases before 2.9.0 claim
  only `queued` and `move_queued`, so they never start a test step.
- The test server is held by the test row, not by a job: from the claim of `check_space` (when `started_at` is set)
  until `cleanup` is `done` or `acknowledged`, `claimJob`, `claimInstall` and "Install on server" refuse other work
  whose server is the test server (`src/restore-tests/hold.js`, the same predicate as the partial unique index).
  Other servers are unaffected.
- `busy(siteId)` excludes `restore-test` jobs. A pending or failed clean-up never blocks the site's backups, readiness
  checks or restores on its own server (unless that is the test server).
- Order: `claimJob` sorts `restore-test` jobs after every other queued job, then by `created_at`. A test is not started
  when an enabled backup policy of a site on the test server has `next_run` within the test's time limit.
- One unfinished test per site and one active test per test server (partial unique indexes, below).
- Retention: unchanged rules, plus `deletionBlocked` refuses a backup with an unfinished test or clean-up. This is the
  test's lease on the package.

## Evidence and history

- Each test is one `restore_tests` row. `result`, `failed_step`, `reason`, `checks`, `restore_seconds` and
  `total_seconds` are written once; a trigger refuses later changes and deletes. Steps are never deleted.
- A deleted backup keeps its tests: `backup_id` becomes NULL and `backup_captured_at` stays.
- Backup evidence is written only for `passed` and `failed`, never for `couldnt_run` or `cancelled`. It is appended to
  `backup_verification_history` with method "automatic restore test": `integrity` from "Backup authentic",
  `isolatedRestore` passed or failed (not for a failure at `copy_backup`), and `application` only when database or
  SQLite checks ran. As for manual restores, a backup with an `application` pass is kept by retention's existing
  "newest proven point" rule. The current `backup_verifications` row is
  replaced only when it is missing, `not-tested`, or itself from an automatic restore test. A manual restore's
  `passed` is never overwritten by a test; the newer test result shows in the history and on the test card.
- `reason` is one plain sentence, at most 300 characters, scrubbed with the move journal's secret-looking-data check.
  No environment values, data paths, logs or response bodies.

## Alerts

New events in `src/alerts/events.js`, detected by `detect.js` from `restore_tests` with a new cursor field `tests`
(missing means "start now", so no history is replayed):

| Event | When | Message |
|---|---|---|
| `restore_test.failed` | A test ended `failed` | `Restore test failed: {site} on {server} at {time}. Open DockNest to see why.` |
| `restore_test.couldnt_run` | A test ended `couldnt_run` | `Restore test couldn't run: {site} on {server} at {time}. Open DockNest to see why.` |
| `restore_test.recovered` | A pass after the previous finished test failed | `Restore test passed again: {site} on {server} at {time}.` |
| `restore_test.needs_you` | Clean-up failed after its retries | `Restore test could not clean up on {server}. Open DockNest to check it.` |

Keyed by test id (occurrence events, never repeated). `{server}` is the test server; site and server rules match
(`targetServerId` is set). Names only, as the alert policy requires. No webhooks.

## Audit events

`restore_test.settings` (changed fields; settings hold no secrets), `restore_test.enqueue` (actor, trigger, backup),
`restore_test.skipped`, `restore_test.passed`, `restore_test.failed`, `restore_test.couldnt_run` (step),
`restore_test.cancelled`, `restore_test.cleaned` (counts), `restore_test.cleanup_failed`,
`restore_test.recovery_acknowledged`. Viewing the storage report is read-only and not logged.

## API contract

All routes need a session; changes need CSRF. Settings: administrator only. Read, run and cancel: operators too.

`GET /api/sites/:id/restore-tests` → the site's card:

```json
{
  "settings": { "enabled": false, "cadence": "weekly", "serverId": null, "allowLiveServer": false,
    "allowInternet": false, "timeLimitMinutes": 30, "memoryMb": 1024, "cpus": 1,
    "probe": null, "nextDueAt": null, "skipReason": null },
  "last": { "id": "uuid", "result": "passed | failed | couldnt_run | cancelled", "finishedAt": "ISO",
    "restoreSeconds": 84, "internet": false, "failedStep": null, "reason": null, "serverName": "test-srv" },
  "active": { "id": "uuid", "state": "queued | running | cleaning", "step": "copy_backup" },
  "items": [ { "id": "uuid", "backupId": "uuid", "backupCapturedAt": "ISO", "trigger": "schedule | manual",
    "result": "passed", "finishedAt": "ISO", "restoreSeconds": 84 } ],
  "next": "cursor or null"
}
```

`probe` is `{ "service": "container name", "port": 8080, "path": "/" }` or null. `last` and `active` may be null.

`PUT /api/sites/:id/restore-tests/settings` takes the `settings` fields (without `nextDueAt`, `skipReason`). Errors:
400 `INVALID`, 409 `TEST_SERVER_REQUIRED`, 409 `LIVE_SERVER_NOT_ALLOWED`, 403 `REVERIFY_REQUIRED` (turning on
`allowLiveServer` or `allowInternet`), 409 `PROBE_STATIC`, 409 `CPUS_ABOVE_SERVER`. Turning tests off does not cancel a
running test.

`POST /api/sites/:id/restore-tests` body `{ "backupId": "uuid" }` (optional) → 202 `{ "id", "jobId" }`. 409
`TEST_ACTIVE`, `NO_VERIFIED_BACKUP`, `SITE_BUSY`, `NO_TEST_SERVER`, `EXTERNAL_STORAGE`; 429 `TOO_MANY_TESTS`.

`GET /api/restore-tests/:id` → full detail:

```json
{ "id": "uuid", "siteId": "uuid", "backupId": "uuid", "backupCapturedAt": "ISO", "serverId": "uuid",
  "serverName": "test-srv", "trigger": "manual", "state": "queued | running | cleaning | finished | needs_cleanup",
  "result": null, "failedStep": null, "reason": null, "restoreSeconds": null, "totalSeconds": null,
  "createdAt": "ISO", "startedAt": "ISO", "finishedAt": null, "deadlineAt": "ISO", "cancelRequested": false,
  "cleanup": "pending | done | failed | acknowledged",
  "limits": { "memoryMb": 1024, "cpus": 1, "timeLimitMinutes": 30, "internet": false },
  "steps": [ { "step": "check_space", "label": "Check space", "state": "pending | running | done | failed | skipped",
    "startedAt": null, "finishedAt": null, "detail": null } ],
  "checks": [ { "name": "Containers running", "kind": "running | health | stable | database | sqlite | http | static-files",
    "target": "web", "status": "passed | failed | skipped | not-configured", "detail": "HTTP 200 in 140 ms" } ] }
```

A failed or couldn't-run test shows `failedStep` and `reason`; the step carries the same sentence in `detail`.

`POST /api/restore-tests/:id/cancel` → 202 (sets `cancel_requested`). `POST /api/restore-tests/:id/cleanup` retries
clean-up of a `needs_cleanup` test (administrator). Acknowledging uses `POST /api/jobs/:id/recovery`.

Implementation notes (PR C, `src/restore-tests/routes.js`):

- `GET /api/sites/:id/restore-tests/settings` returns the `settings` object (administrator only); the card carries the
  same object for operators. The card takes `?cursor=` (20 items a page) and `?backupId=` to list one backup's tests.
- `PUT .../settings` answers with the saved `settings`. Validation errors are 400 `INVALID` with a plain sentence.
  `CPUS_ABOVE_SERVER` uses the CPU count that "Check space" records in the test server's facts (`capabilities.cpus`);
  until a first test has run there, the cap is enforced at "Check space" only.
- A probe of only `{ "path": "/health" }` is completed at test creation: the first container that ran at capture and
  exposes a TCP port, preferring 80, 8080, 8000, 3000, 5000, 443, 8443, 8081 and 2368. Without one, no web check runs.
- `POST /api/sites/:id/restore-tests` returns `jobId: null` while the test waits for its server or a due backup; the
  first step is queued at once otherwise. 429 `TOO_MANY_TESTS` says "You can run 6 tests a day for each site."
- Cancel of a test whose first step no worker has claimed ends it at once (`cancelled`, nothing reached the server).
- `POST /api/jobs/:id/recovery` for a `restore-test` job: administrator only, body `{ "confirmation": "<site name>",
  "reviewedRemoteRecovery": true }`; 409 `LEFTOVERS` while `restore-test-status` reports anything, 502 `UNREACHABLE`
  when the test server does not answer.
- The schedule runs inside the worker's existing tick (`tickRestoreTestSchedule`, before `tickRestoreTests`), with no
  loop or timer of its own. A skipped run stores its reason in `skipReason` and audits `restore_test.skipped` with a
  reason code only.

`GET /api/backups` and backup detail add `restoreTest: { "status": "passed | failed | not-tested", "testId",
"testedAt" }` from the newest `passed` or `failed` test of that backup.

## Storage report (Q6 / PM-19)

Helps the owner decide later whether incremental backups are worth building. It measures what is stored and gives a
rough best-case estimate per site, labelled as an estimate.

```json
{ "generatedAt": "ISO",
  "storages": [ { "id": "local | target uuid", "name": "Local disk", "packages": 42, "bytes": 0, "capacityBytes": null } ],
  "sites": [ { "siteId": "uuid", "name": "shop", "packages": 7, "bytes": 0, "newestBytes": 0,
      "growthPerBackupBytes": 0, "estimate": { "upToBytes": 0, "upToPercent": 0 } } ],
  "totals": { "packages": 0, "bytes": 0, "estimateUpToBytes": 0 },
  "method": "plain sentence shown under the numbers" }
```

- Bytes are `backups.size` of current packages. Storage comes from the backup path reference (`sftp:<id>:`,
  `s3:<id>:` or a local path).
- Estimate per site, packages by capture time: `needed = max(largest package, first package + sum of every increase
  between consecutive packages)`; `upTo = stored - needed`, never below zero.
- It treats only growth as new data, so it is a best case. Real savings may differ: it cannot see which bytes changed
  inside an encrypted, compressed package (a database rewritten in place at the same size counts as unchanged here);
  it does not see base images repeated in every package or shared across sites, an incremental tool's index, or
  compression differences. The card says: "Up to {x} might be saved. A rough best-case estimate from package sizes;
  DockNest cannot see inside encrypted backups."
- Computed on request from metadata. It reads no backup data and calls no site server. `capacityBytes` uses the
  existing storage capacity call to each destination, cached for 10 minutes; a destination that does not answer
  shows "unknown". Nothing is stored. No new dependencies.

## Data model (migration `restore-tests`, `compatible: true`)

The number is the next free one at merge time (currently 9). New objects only; nothing altered, no rows inserted.
`tests/migrations.test.js` gains the case.

- `restore_test_settings(site_id PK → sites, enabled 0/1 DEFAULT 0, cadence CHECK daily|weekly|monthly DEFAULT
  'weekly', server_id → servers NULL, allow_live_server 0/1 DEFAULT 0, allow_internet 0/1 DEFAULT 0,
  time_limit_minutes INTEGER CHECK 10..120 DEFAULT 30, memory_mb INTEGER CHECK 256..16384 DEFAULT 1024, cpus REAL
  CHECK 0.5..16 in steps of 0.25 DEFAULT 1, probe TEXT NULL CHECK length <= 512, next_due_at TEXT, skip_reason TEXT, updated_at, updated_by)`.
  No row means off.
- `restore_tests(id PK, site_id → sites, backup_id → backups ON DELETE SET NULL, backup_captured_at, server_id →
  servers, job_id → jobs, trigger CHECK schedule|manual, result CHECK passed|failed|couldnt_run|cancelled NULL,
  failed_step, reason CHECK length <= 300, restore_seconds, total_seconds, checks CHECK length <= 8192, limits
  (includes internet, live server and probe; at most 1024 characters), cleanup CHECK pending|done|failed|acknowledged
  NULL, cleanup_attempts, cleanup_next_at, cancel_requested 0/1, deadline_at, created_by, created_at, started_at,
  finished_at, step (the current step), progress (engine state at most 16384 characters: timings, poll times, the
  plaintext SHA256 the helper checks the transfer against; never secret values))`. `finished_at` is when the result
  was written; clean-up may still be pending.
- `restore_test_steps(test_id → restore_tests, step CHECK six keys, state, started_at, finished_at, detail CHECK
  length <= 500, PRIMARY KEY(test_id, step))`.
- Partial unique indexes: `restore_tests(site_id) WHERE result IS NULL OR cleanup IN ('pending','failed')`, and
  `restore_tests(server_id) WHERE started_at IS NOT NULL AND (result IS NULL OR cleanup IN ('pending','failed'))`, so
  queued tests for one test server wait in line instead of hitting a constraint error. Plain indexes: `(site_id, created_at, id)` for keyset paging,
  `(backup_id, created_at)`, `restore_test_settings(next_due_at) WHERE enabled = 1`.
- Triggers: refuse `DELETE` on both tables; refuse changing `result`, `failed_step`, `reason`, `checks`,
  `restore_seconds`, `total_seconds` once `result` is set.

## Helper version

`VERSION=1` in `remote/helper.py` stays 1. It is also the backup `formatVersion` that `unpack_verified` requires, so
raising it would refuse every existing backup. New operations are detected by name. Boot recovery's "outdated" flag
is hash based (`bootRecoveryBundle.sha256`), so any helper change already shows installed copies as outdated until
reinstalled. If a helper protocol version is ever needed, it becomes a separate constant from the format version.

## Helper operations

All take `testId` (a canonical UUID). The ones that change the server hold a per-test lock and stop when DockNest
stops waiting (stdin closes), as moves do. Verdicts come back as a result, not an error: `outcome` is `ok`, `failed`
(the backup did not come back) or `couldnt_run` (the test server or a limit stopped it), with one plain `reason` of at
most 300 characters and the `checks` so far. Docker errors report only the command name and exit code, never
arguments (they hold data paths).

| Operation | Step | What it does |
|---|---|---|
| `restore-test-check` | `check_space` | Read-only facts and plain problems: root, free space, `MemAvailable`, `nproc`, Docker version, architecture, leftovers, `iptables`/`ip6tables`/`nsenter` (internet), `setpriv`. |
| `restore-test-prepare` | `copy_backup` | Journal directory, staging root (journalled first), deadline, reaper. Returns the SFTP path. |
| `restore-test-run` `phase: restore` | `restore_copy` | Verify and unpack, static digest or SQLite proofs, image IDs and tags recorded, `docker load`, tags restored, networks and containers created with limits and labels, mail blocked with internet. Starts nothing. |
| `restore-test-run` `phase: start` | `start_containers` | Free space checked; containers started in restart order (each level waits for the one before to be healthy); with internet, rules go into each copy's namespace before it joins the egress network. |
| `restore-test-run` `phase: poll` | `check_health` | Running and health; `final: true` (the end of the step) adds free space, database checks and the web check. |
| `restore-test-teardown` | `clean_up` | The teardown above. Waits up to 200 seconds for a stopped step to let go. Keeps the journal while anything is left. |
| `restore-test-status` | recovery | Counts of labelled containers, networks, firewall rules, and whether staging or the journal exist (`present`). |
| `restore-test-mail-check` | any | On request: whether every rule is still in each running copy's namespace. |
| `restore-test-reap` | reaper | Started by `prepare` only. |

## Upgrade safety

- Upgrading from 2.8.x runs the migration after the normal pre-upgrade snapshot. Tests are off for every site because
  no settings row exists. Backups, restores, moves and alerts behave as before. Existing alert rules do not gain the
  new events; the owner ticks them.
- The compatibility floor does not move, so rolling back to 2.8.x still opens the database. 2.8.x ignores `test_*`
  jobs and the new tables, but it also does not see a test holding a server. `upgrading.md` gets: "Finish or cancel
  restore tests before rolling back to 2.8.x." A test caught mid-run is removed by its reaper.
- Upgrade fixtures (PM-01) gain a 2.8.2 database; the test asserts exact preservation and idempotence.

## Security review points

1. Secrets: the decrypted package reaches the test server, as in a manual restore. Staging is root 0700 and removed by
   teardown. Settings, steps, checks, reasons, audit details and alerts hold no secret values; the probe stores no body.
2. Isolation: no internet by default, no published ports, no privileged settings, restart `no`, unique names and labels,
   Compose project label replaced. Live server and internet each need an administrator and re-verification; with
   internet, mail, the metadata service and this server are rejected inside each copy's namespace before it gets a
   route out, or the test refuses to start.
3. Image tags are restored right after `docker load`, so a test never changes what a later `docker compose up` runs.
4. Resource abuse: memory, swap, CPU, pids and log limits, a time limit, free-space checks at step changes, one test per server, memory
   and CPU prechecks, at most daily scheduling and 6 manual runs per site per day. Disk is not capped.
5. Probe: nobody uid with no new privileges, loopback in the container's namespace, isolated Python, capped size and
   time, no redirects.
6. Clean-up: label and journal must agree; fixed roots only; never `docker image rm -f`; a failure blocks only the test
   server and alerts.
7. Reaper: reviewed source sent by the manager, root-owned 0700, one timer, one teardown only if the journal is still
   there, its own systemd scope where available.

Sign-off before PM-23 merges: Security Engineer and Reality Checker (per PM-22).

## Linux integration test plan

`scripts/integration-restore-test.js`, in the `linux-integration` CI job on real Docker 28+:

- Single container with a healthcheck: passes; `HostConfig.Memory`, `NanoCpus`, `PidsLimit` and `LogConfig` match;
  `NetworkMode` is `none`; no port bindings.
- Grouped Compose site (web + PostgreSQL with a row-count check and a web check on `/`): passes. Isolation asserts
  from inside a container: no route to the host gateway IP, to `169.254.169.254`, to a public IPv4 or IPv6 address,
  and no public DNS answer.
- Grouped site with Allow internet: outbound HTTPS works; ports 25, 465, 587 and 2525, `169.254.169.254` and the host
  gateway are rejected; the in-namespace rules exist for IPv4 and IPv6. A host iptables flush mid-test (`iptables -F`,
  `ip6tables -F`) leaves the in-namespace rules intact and mail is still blocked.
- Allow internet is refused when a container adds `NET_ADMIN`.
- Static site: passes on the digest.
- Failures: a container that exits after 20 seconds fails at "Still running"; one that exceeds its memory ends
  `couldnt_run` (memory limit) with no backup evidence written.
- Live-server opt-in next to a running fixture site: live containers, tags and ports unchanged afterwards.
- Docker with the containerd image store enabled: tag restore and image removal behave the same.
- Restarts: kill the worker during `restore_copy`; the next worker cleans up. Stop the manager past the deadline; the
  reaper cleans up.
- After every case: no labelled container or network, the image ID set and every tag equal to before, no staging or
  journal path, no firewall rule, `restore-test-status` reports nothing left.
- Not possible on GitHub-hosted runners: real IPv6 egress (the runners have no IPv6 route), so the IPv6 case asserts
  the `ip6tables` rules inside the copy instead of sending IPv6 mail.

Not "validated" until all cases pass in CI on Linux.

## QA plan

- Unit and API (node:test): migration from a 2.8.2 fixture in `tests/migrations.test.js`, idempotent, floor
  unchanged; triggers; `claimJob`/`claimInstall` server blocking by the test row and ordering; `busy()` ignores tests;
  step machine and cancel; scheduler due times and skips; evidence never downgrades another method; `deletionBlocked`
  lease; settings validation, roles, re-verification, rate limit; alerts detection and messages; storage estimate
  maths with growing, shrinking and single-package sites.
- Python (`remote/test_restore_tests.py`): journal before create, teardown idempotent and label-gated, tag restore,
  path roots, reaper exit without journal, probe limits, status output.
- Browser suites: settings sheet (live-server and internet warnings), Run test now, step timeline in each state,
  failed and couldn't-run tests with step and reason, per-backup Tested state, storage report, phone width, light and
  dark.
- Design review against [DESIGN.md](design/DESIGN.md): `StatusLabel` states, Tabler icons and tokens, no emoji.

## Implementation PRs

1. Helper: `restore-test-check`, `-prepare`, `-run` (phases `restore`, `start`, `poll`), `-teardown`, `-status`,
   `-mail-check`, the reaper (`-reap`), limits, tag restore, mail block, Python tests. Security-critical review.
2. Engine: migration, test rows, step machine in the worker tick, `claimJob`/`claimInstall`/`busy()` changes,
   startup clean-up, lease, evidence rules, Linux integration script. Engine functions for PR C: `createRestoreTest`,
   `cancelRestoreTest`, `retryRestoreTestCleanup`, `acknowledgeRestoreTestCleanup`, `latestTestableBackup`.
3. API, scheduler, alerts and audit events, with API tests.
4. UI: site settings, run now, timeline, backup Tested state, failure details. Browser tests and design review.
5. Storage report (API and card) and docs: README, `alerts.md`, `recovery-verification.md`, `upgrading.md`, release
   notes.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the design and trade-offs, and
[Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md)
for isolation, secrets, abuse limits and clean-up failure handling.
