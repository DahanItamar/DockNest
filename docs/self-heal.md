# Self-heal for unhealthy containers (ADR, issue #150)

Status: proposed design for 2.15.0 "Safe changes", awaiting owner approval. Date: 2026-11-02. No code yet.
Builds on [remote-helper.md](remote-helper.md), [alert-channels.md](alert-channels.md) and [security.md](security.md).

When Docker marks a container of a site unhealthy, DockNest restarts it, up to a set number of times in a time window,
and tells the owner through the existing alert Connections. It is opt-in per site and off by default.

Docker's own restart policies already restart containers that exit. They do nothing for a container that keeps running
but fails its health check; that is the gap this fills.

## Goals

- React to Docker's `health_status: unhealthy` event within seconds, without a polling loop.
- Bounded: at most N restarts per container per window, then stop and alert.
- Never fight DockNest's own work (backups stop containers on purpose, restores, moves, Safe Edits, restore tests).
- Audited and visible: every restart is a row in the site's history.

## Non-goals

- No restart of containers without a Docker health check (no HTTP probing from DockNest for this feature).
- No healing of exited containers (Docker's restart policy owns that), no recreate, no rollback, no scaling.
- No healing while DockNest is down (see "The choice" and owner question 1).
- No log or metrics collection.

## The choice: how events reach DockNest

The dashboard never mounts the Docker socket and reaches servers only over SSH with pinned host keys, running the
Python 3 standard-library helper sent on each call. Three options were weighed:

| Option | How | For | Against |
|---|---|---|---|
| A. Polling | Worker runs `docker ps --filter health=unhealthy` every minute | Simple | A polling loop (owner rule against it); up to a minute late; SSH traffic all day. Rejected. |
| B. Held SSH event stream (chosen) | The worker holds one SSH session per server with at least one opted-in site, running helper op `health-events`, which runs `docker events --filter type=container --filter event=health_status --format '{{json .}}'` and forwards matching lines | Purely event-driven; nothing installed on the server; restarts, locks, audit and alerts stay in one place that already knows about backups and moves; works with every supported server today | Heals only while the worker runs and the server is reachable; one long-lived SSH session per server |
| C. Listener on the server | A systemd service (installed with consent) runs a stdlib listener and restarts locally | Heals while DockNest is down | New persistent root software on every server, its own update and uninstall story, its own copy of the locks (it cannot see DockNest's queue, so it would restart containers a backup stopped), a second channel back to DockNest for alerts. |

**Decided (lead): B.** It keeps the existing trust model (no new resident root code, nothing listening on servers), and
only the manager knows when a container is down on purpose. The cost, "no healing while DockNest is down", is stated
in the UI ("Works while DockNest is running") and docs. C stays possible later as an add-on (owner question 1).

### How the stream works

- `src/self-heal/streams.js` in the worker. On start, and when a site's setting changes (an event from the API through
  the existing worker wake-up, not a timer), it opens or closes one stream per server that has an enabled site.
- The stream is one SSH exec of the helper with `operation: health-events` and the exact container names of the
  enabled sites on that server. The helper starts `docker events` (no `--since`; see the review changes), keeps only those names, and writes one JSON line per event: `{container, status, at}`
  (`status` is `healthy`, `unhealthy` or `starting`). Nothing else is forwarded (no attributes, labels or env).
- Liveness: ssh2 transport keepalive (15 s, 3 misses). This is the TCP-level heartbeat of the session, not a state
  poll. When stdin closes the helper stops `docker events` (existing `stop_after_stdin`).
- Reconnect after a drop: exponential backoff with jitter (5 s doubling to 5 minutes), driven by the close event.
  On every (re)connect the helper first emits the current health of the watched containers once
  (`docker inspect` of those names), so an unhealthy transition missed while disconnected is acted on. That is one
  read per connect, not a loop.
- The worker's SQLite lease already guarantees one worker, so there is never a second stream for a server.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Who | Administrators turn it on per site. Operators see the setting and history read-only. No re-verification (it only restarts containers the site already runs). Decided (lead). |
| Limits | Restart up to N times (1-10, default 3) per container in a window (10 minutes to 24 hours, default 1 hour). At least 60 seconds between two restarts of one container. Decided (lead). |
| Which containers | Only containers of the site that have a Docker health check. The setting shows which ones are watched; a site with none cannot turn it on ("No container in this site has a health check"). Decided (lead). |
| When it waits | No restart while the site has a queued or running job (backup, restore, Safe Edit), an unfinished move, is in maintenance, or within 2 minutes after such work ended (containers starting). The event is recorded as `skipped` with the reason. Decided (lead). |
| Restart | A short job `self-heal` (statuses `heal_queued`/`heal_running`, never claimed by older releases), sorted first in `claimJob` (it is seconds). The helper re-reads the container's health right before acting and restarts only if it is still `unhealthy` (`docker restart --time 30 <name>`). Decided (lead). |
| Recovered | The next `healthy` event for that container closes the episode (`recovered`). |
| Limit reached | Further unhealthy events in the window are recorded as `limit_reached`, no restart, alert `self_heal.gave_up` once per window. |
| Alerts | New events `self_heal.restarted` and `self_heal.gave_up` (site events). Which ones are sent: owner question 2. |
| Audit | `self_heal.enabled`, `self_heal.disabled`, `self_heal.changed` (actor), `self_heal.restarted`, `self_heal.gave_up` (actor `self-heal`). |
| Schema | Migration `self-heal`, next free number at merge (currently 14), `compatible: true`, new tables only. |

## Threat model

| Threat | Control |
|---|---|
| Restart storm (flapping health check) | N per window, 60 s minimum gap, one restart job per container at a time, `limit_reached` stops it. |
| Fighting DockNest work (a backup stopped the container; a restore is starting it) | The busy/maintenance/move checks above, made at claim time inside `BEGIN IMMEDIATE`, plus the 2-minute settle. |
| Restarting the wrong container (name reuse, restore test copies, a moved site's stopped old copy) | Exact names from the site record, re-checked against the Compose project and service labels; restore test containers (`dbm-test-*`, label `docknest.restore-test`) and move copies (label `docknest.move`) never match. |
| A hostile container fakes events | Events come from the Docker daemon, not from containers. A container can make itself unhealthy, which only gets it restarted within its limit. |
| Event content as an injection vector | The helper forwards only name, status and time; the worker validates name against the watched set and status against three values; anything else is dropped. Nothing from the event reaches a shell, an alert text or a log line. |
| Held SSH session abuse | Same pinned host key and helper as every call; the session runs only `health-events`; it carries no secrets. |
| Alert spam | Dedupe per container per window; `gave_up` once per window. |
| DockNest down or server unreachable | No healing (documented). `server.unreachable` already alerts. |

## Data model (migration `self-heal`, `compatible: true`)

Next free number at merge time (currently 14, after Safe Edit). New objects only.

- `self_heal_settings(site_id PK → sites, enabled 0/1 DEFAULT 0, max_restarts INTEGER CHECK 1..10 DEFAULT 3,
  window_minutes INTEGER CHECK 10..1440 DEFAULT 60, watched TEXT CHECK length <= 4096 (JSON: container name, ID,
  project label), last_event_at TEXT, updated_at, updated_by)`. No row means off.
- `self_heal_events(id PK, site_id → sites, server_id → servers, container TEXT CHECK length <= 128, kind CHECK
  unhealthy|restarted|restart_failed|recovered|skipped|limit_reached, reason CHECK length <= 300, job_id → jobs NULL,
  at TEXT)`. Index `(site_id, at, id)`. Triggers refuse `UPDATE`, and `DELETE` of a row newer than 90 days; the worker's
  existing maintenance step deletes older rows when it runs.

## API

- `GET /api/sites/:id/self-heal` (any signed-in user for the site): settings, watched containers, stream state
  (`connected`, `connecting`, `off`), recent events (keyset paging).
- `PUT /api/sites/:id/self-heal` (administrators, CSRF): `{ enabled, maxRestarts, windowMinutes }`; 422 `NO_HEALTHCHECK`.
- `GET /api/self-heal/events?siteId=&after=` for the history table.

## Worker and helper changes

- Worker: `streams.js` (open/close/reconnect), `tickSelfHeal()` only turns recorded `unhealthy` events into `heal_queued`
  jobs when the checks pass (it does not read servers). `claimJob` sorts `self-heal` first; `busy()` ignores
  `self-heal` jobs so a restart never blocks a backup.
- Helper module `remote/helper/heal.py`: `health-events` (stream, read-only) and `self-heal-restart` (project, service
  and name; refuses if the labels differ, the container is not running or health is not `unhealthy`). Fixed argv, no shell.

## Failure paths

- Restart command fails: `restart_failed` with the exit code only; counts toward the limit; alert as `restarted`.
- Container still unhealthy after restart: Docker sends `unhealthy` again after its own retries; next restart if
  under the limit and past the gap.
- Stream cannot start (`docker events` refused, old Docker): the setting shows "Not watching: {reason}", no restarts.
- Worker restart: streams reopen on start and the connect snapshot covers missed transitions; an interrupted `heal_running` job is failed
  (no retry; the next event decides).

## Security review changes (binding)

The security review (2026-11-02) tightened the design. Where this section and the text above differ, this section wins.

1. **Restarts and backups never overlap.** A queued or running `self-heal` job counts as busy for its own site
   (seconds), so a backup waits for it; and Safe Edit, move and backup claims wait for a running heal job of the site.
   `self-heal-restart` takes the same per-site lock file as backup and edit operations, refuses unless `State.Running`
   is true and `State.Health.Status` is `unhealthy`, and re-checks the maintenance marker on the server.
2. **Identity by Compose labels, not container ID.** Containers are identified by `com.docker.compose.project` plus
   `com.docker.compose.service` (or the exact name for single-container sites). The watched set is re-resolved after
   every site job and on every stream connect; if a watched service disappears the setting shows "Not watching:
   container recreated" and `self_heal.gave_up` fires with that reason. `watched` stores project, service and name.
3. **No `--since`.** Replay is dropped; the inspect snapshot on connect covers missed transitions. Events are deduped
   on (container ID, daemon `timeNano`).
4. **Event format pinned.** The helper parses `Action` (`health_status: unhealthy|healthy|starting`) explicitly; a
   Python test pins it on captured real output; the Linux run covers the oldest supported Docker and 28.
5. **Stream lifecycle.** The stream closes and reopens on host-key re-pin, credential change, server removal, a site
   move, and a Safe Edit that changes the services; it fails closed on a pin mismatch.
6. **Bounded helper.** `docker events` runs in its own process group, killed when stdin closes; lines over 4 KB are
   dropped and more than 50 lines per second closes the stream (reconnect with backoff). The stream uses its own SSH
   connection, separate from job traffic. Docs note `MaxSessions` and `ClientAliveInterval`.
7. **Plain failures.** Known `docker restart` exit codes map to fixed sentences; never stderr.
8. **Extra Linux cases:** a container recreated by `compose up` after enable is still healed; a backup stopping the
   container while a heal job is queued (no start); Safe Edit at the same time; worker SIGKILL leaves no orphan
   `docker events`; Docker daemon restart while streaming (reconnects).

## Upgrade safety

Additive migration; off for every site. Rolling back to 2.14.x ignores the tables and `heal_*` jobs; any queued restart
simply never runs. Existing alert lines do not gain the new events.

## Test plan

- Unit: window counting, gap, limit, dedupe, busy/maintenance/move/settle skips, claim ordering, ID mismatch refusal,
  reconnect backoff with jitter (fake timers), event validation drops unknown fields, migration from a 2.14 fixture.
- Python: event filter and output shape, Action parsing, inspect on connect, restart refuses healthy or wrong ID.
- Browser: settings card, watched list, no-healthcheck state, history table, phone and both themes.
- Linux integration (`scripts/integration-self-heal.js`):
  1. Container whose health check fails after a file is removed: restarted within 20 s, `recovered` after the file
     returns via its entrypoint.
  2. Always-failing health check: exactly N restarts, then `limit_reached` and one `gave_up` alert in the outbox.
  3. Backup running on the site while the container turns unhealthy: `skipped`, no restart.
  4. Drop the SSH session (kill sshd child) while a container turns unhealthy: on reconnect the restart happens.
  5. A restore test copy with the same service name on the same server: never restarted.
  6. Worker restart: stream resumes, no duplicate restart for an already handled event.

## Real and unusual use cases

- A PHP app whose workers hang under memory pressure; health check `curl /health` fails; restart fixes it.
- A database that is unhealthy for 5 minutes during a long recovery: limit and gap prevent restart loops; owner sets
  window and N to fit.
- Health check with `start_period` 5 minutes: `starting` is ignored; only `unhealthy` acts.
- The server reboots: containers start, Docker reports `starting`, then `healthy`; no restarts.
- The owner stops a container by hand: no health event, nothing happens.
- Two sites on one server opt in: one stream for both.
- Laptop-hosted DockNest that sleeps at night: healing pauses, docs say so.

## Owner questions

1. **Heal while DockNest is down.** Offer the on-server listener (option C) as an optional add-on later?
   Recommendation: not now. Ship B, see how often it matters; Docker's restart policy covers crashes meanwhile.
2. **Which restarts alert.** Every restart, or only the first in a window plus "gave up"? Recommendation: first restart
   in a window and "gave up"; all restarts stay in the history.
3. **Defaults.** 3 restarts per hour, 60 seconds apart? Recommendation: yes.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the event channel choice,
[SRE](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-sre.md) for restart limits and
failure modes, and
[Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md)
for the threat model.
