# Back up any container, coverage, and the restore check (ADR)

Status: accepted for 2.16.5 (boards approved 2026-11-19). Date: 2026-11-19.
Depends on: the Sites to Apps rename and `shared/backup-coverage.js` (integration/2.16.5). Internal names (`sites`,
`site_id`, `/api/sites`) stay; all new copy says "app".

Two features:

- **A. Back up any container.** Containers started with plain `docker run` become an app, with a readable
  Compose-equivalent definition, and a per-server coverage view shows what is and is not backed up.
- **B. Will a restore really work?** Per app, a read-only list of what a fresh server would be missing.

## Audit: what already exists

| Area | What DockNest does today | Gap |
|---|---|---|
| Discovery | `discover` lists every container. The add flow and the Map list non-Compose containers one by one ("Ungrouped containers"); several can be ticked into one app. | No hint that plain containers belong together (shared network). Volumes nobody mounts are not listed. |
| Capture | A non-Compose app is already backed up: full `docker inspect` in the manifest, a `docker commit` snapshot image, every mount archived. Privileged or device containers and non-local volumes are refused at preflight. | The package holds raw inspect JSON only: nothing a person can read or run to recreate the container without DockNest. |
| Restore (isolated) and restore tests | Recreate from the snapshot image with `--network none` or isolated networks, original mounts and hardening. | Fine for proving data comes back; not a real recreate. |
| Move (real recreate) | `docker create` from the snapshot image keeps name, restart policy, networks and aliases, ports, tmpfs, hardening, mounts, extra hosts, init. Image config (env, command, entrypoint, user, workdir, labels, healthcheck, stop signal) travels with the commit. | Silently dropped: TTY and stdin, hostname, memory, CPU and pids limits, ulimits, log options, DNS, shm size, sysctls, group-add, publish-all (`-P`), stop timeout. |
| Coverage | `useDiscovery` on the Map already subtracts containers that are in an app. The other lead's `shared/backup-coverage.js` makes this shared, with a 409 `CONTAINER_ALREADY_BACKED_UP`. | No per-server view, no volumes, no way to mark something as skipped on purpose. |
| Readiness (Check readiness) | Read-only helper operation. Required checks plus non-blocking warnings: mounts not copied (passwords, sudoers, keys) and `.ssh`/`.gnupg` folders left out. | Nothing about the host around the app. |
| Host timer fix (Unreleased) | A backup that stops because a folder changed while paused now names the folder. | It reports the symptom after the fact; nothing finds the timer beforehand. |
| Move preflight | Refuses Compose `external:` networks and volumes, non-bridge drivers, fixed subnets, file-based secrets and configs, and checks certbot on the target. | Only at move time, only for Compose apps, and as a refusal rather than a list. |
| Add-app confirmation | "I reviewed external dependencies and included the configuration files and secrets" is a checkbox the user ticks with no help. | Nothing tells the user what those dependencies are. |
| Restore tests and hardening score | Prove data restores in isolation; grade container security. | Neither looks at the host, so neither overlaps with B. |

Conclusion for B: the owner is right that parts exist, but scattered (move refusals, readiness warnings, a checkbox).
B **extends Check readiness**; there is no new check system, scheduler or job type.

## Decisions

### A1. No new app kind

A plain container stays `kind: 'docker'` with `containers: [names]`. Capture, isolated restore and restore tests
already work and are unchanged. Adoption never stops, recreates or edits the live container: the new helper operation
only reads `docker inspect`.

### A2. One run-spec module in the helper

`remote/helper/runspec.py` (standard library only) turns one inspect record into a normalised run spec and a list of
settings it cannot recreate. It has three users, so there is one source of truth:

1. **`describe-containers`** (new read-only operation): returns the spec for preview. Environment values never leave
   the server here: the preview shows variable names only.
2. **Backup** of a non-Compose app writes `run-definition/compose.yaml` and one `run-definition/<container>.env` per
   container (two containers may use the same variable name with different values) into the encrypted package,
   recorded in `manifest.runDefinition` so older packages and helpers are unaffected. This adds no new exposure: the manifest already holds the full inspect, env values included.
   The image is the snapshot image (writable layer kept); the original reference is a label.
3. **Move** builds its `docker create` flags from the same spec, adding the dropped settings above.

YAML is emitted by a small writer that quotes every scalar as a JSON string (valid YAML), so there is no YAML library.
The Linux integration test runs `docker compose config` on the output and recreates from it.

Fail closed: settings the spec cannot recreate (devices, GPUs, custom runtime, cgroup parent, host/PID/IPC namespaces,
`volumes-from`) are listed by name in the preview. What preflight refuses today stays refused; Move gets **no new
refusals** (upgrade safety): a setting it used to drop is now either recreated or named in the Move preview. A CPU
limit or CPU set the target cannot satisfy is capped or dropped, and the preview says so.

### A3. Discovery suggests groups

Plain containers that share a user-defined network are offered as one suggested app in the add flow ("3 containers on
network shopnet"). It is only a pre-selection; the user can untick any of them.

### A4. Coverage view

- `GET /api/servers/:id/coverage` runs the existing `discover` (extended additively with `volumes` from
  `docker volume ls`) and classifies every container and volume with `shared/backup-coverage.js`:
  **Backed up** (which app, once it has at least one verified backup; before that a "first backup pending" warning), **Not backed up**, or
  **Skipped on purpose** (with the note). Volumes count as backed up when a container of an active app mounts them.
- DockNest's own containers (restore copies, Safe Edit holders, move test copies) are not listed.
- On demand only: opening the view or "Scan again". No timer, no stored scan.
- A failed or incomplete scan shows an error or "partial" state and never "everything is backed up".
- Ignore list: new table `server_coverage_ignores (server_id, kind container|volume, name, note, created_by,
  created_at)`, keyed by name (names survive recreates, IDs do not). Additive migration, `compatible: true`, next free
  number at merge. Admins and operators change it, viewers read it; changes are audited.
- UI: a Coverage panel per server on the Apps page, and a "Coverage" toggle on the Map that adds a status count to
  each server node and the list to the server panel, reusing Map rows, notes and tokens. "Add app" on a not-backed-up
  item opens the existing add flow with it pre-selected (the Map's existing `initialPick`).

### B1. The restore check extends Check readiness

`remote/helper/restore_gaps.py` runs inside the `readiness` operation and returns `restoreGaps` next to `checks`.
It never changes `ready`. Findings:

| Kind | How it is found |
|---|---|
| Host schedule | `/etc/crontab`, `/etc/cron.d`, `/etc/cron.{hourly,daily,weekly,monthly}`, `/var/spool/cron/crontabs`, and `*.timer` units in `/etc/systemd/system` with their service's `ExecStart*`, `WorkingDirectory` and `ReadWritePaths`. A match is an absolute path inside the app's folders or a `docker` command naming one of its containers. |
| External network or volume | Compose `external: true`, or a network or volume the app uses that no app container's project created. |
| Bind mount outside the app folder | Copied, restored to the same path; listed so nobody is surprised. |
| Docker secrets and configs | Compose `secrets`/`configs` with `file:` outside the folder (includable) or external/Swarm ones (note only). |
| Certificate | `/etc/letsencrypt/live/<domain>` for the app's domains, and certificate paths in its nginx site. |
| Env file outside the folder | Compose `env_file` entries outside the project folder. |

Secrets: a finding carries the file path, the line number, the schedule and what matched, **never the command or the
line text**, which can hold tokens. Nothing from these files is logged. Reads are bounded (file count and size), never
follow links out of the scanned folder, and skip every path the denylist protects (`.ssh`, `.gnupg`, shadow, sudoers).

### B2. Three answers per finding

- **Include in backup**: offered only when the existing capture path accepts it (a regular, unlinked, unprotected
  file). It adds the path to the app's configuration files through the normal app update, so the existing denylist and
  readiness checks apply. Folders such as `/etc/letsencrypt/live` (links) are not includable; their copy explains the
  alternative (Move issues a new certificate with certbot).
- **Ignore** and **Note**: stored in a new table `site_restore_decisions (site_id, finding_key, decision ignore|note,
  note, decided_by, decided_at)`; `finding_key` is a hash of kind, path and match, so line moves do not reset it.
  Additive migration, `compatible: true`.

Owner answers (2026-11-19):

- **Include in backup** saves a copy in the backup and adds restore-guide steps that say where to put it back by hand.
  Move never writes into `/etc`. The button and its copy say exactly that.
- Include adds a path discovery did not report, so it is for administrators only; operators see it disabled with
  "An administrator can add this". Ignore and Note are open to administrators and operators, and are audited.
- Saving the check with every backup (so Restore and Move can warn) is a later follow-up.

Shown in the Check readiness dialog as a "Restore on a new server" section below the existing checks. The two
existing "not copied" warnings stay in the checks list where they are today; no existing UI moves. The scan runs in the same
readiness call, so the existing "checking" state covers it and there is no second request.

## Upgrade safety

- Two new tables only, in their own migrations (19 `server-coverage-ignores`, 20 `site-restore-decisions`, renumbered
  at merge if needed); never released with a gap in the numbers. Older releases ignore them (`compatible: true`).
- `discover` and `readiness` gain fields; no field changes meaning. A helper that does not know
  `describe-containers` answers "unknown operation", which the UI shows as "update the helper" rather than an empty
  preview.
- Existing backups restore exactly as before; `run-definition/` is new optional package content.

## Testing

Unit tests for runspec (inspect fixtures), the YAML writer, cron and timer parsing, and coverage classification.
Linux Docker integration: adopt a `docker run` container with limits, TTY and a user network; back it up; recreate it
from `run-definition/compose.yaml` and by Move; compare inspect. A cron file and a timer touching the app folder are
found, a secret on the cron line never appears in the result or the logs.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for extending existing checks instead of a parallel system,
[Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md)
for the secret handling and denylists, and
[UX Architect](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ux-architect.md) for the
coverage states and plain-language findings.
