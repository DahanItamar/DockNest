# Safe Edit for sites (ADR, issue #149)

Status: accepted for 2.15.0 "Safe changes". Owner approval 2026-11-02; every owner question is decided below. Date: 2026-11-02.
Builds on [moving-sites.md](moving-sites.md) (journals, Compose allow-list, step machine), [restore-tests.md](restore-tests.md)
("passed" checks, ticked waits) and [security.md](security.md).

An administrator changes a site's Compose file, environment values, published ports or image tag from DockNest.
Saving takes a verified backup first, applies the change, checks the site comes up, and puts the previous version back
by itself when it does not. Every change is audited.

Real Safe Edit counts as validated only when the Linux integration test below passes (see AGENTS.md). Until then it
ships with the "beta" label, like moves and restore tests did.

## Goals

- Change the four things people edit most without SSH: Compose file, environment values, ports, image tag.
- Never leave a site worse than before: backup first, health check, automatic rollback, plain reason.
- Secrets in environment values are write-only: typed in, never shown, stored or logged again.
- A change can never add a privilege the site did not already have.

## Non-goals

- No Dockerfile or build-context editing, no `docker compose build` (an edit never rebuilds; `--no-build`).
- No nginx, certificate, DNS or host-file editing. No editing of data folders.
- No removing a service or renaming a project in 2.15 (refused with "Remove it by hand"). Adding a service is allowed.
- Static sites (no containers) have nothing to edit; the action is hidden for them.
- No scheduled or batched edits, no edit templates, no "edit several sites".

## Decisions at a glance

| Topic | Decision |
|---|---|
| Who | Administrators only, with a re-verification within 5 minutes at **Apply**. Operators see the history read-only. Decided (lead). |
| What | Compose sites: Compose, Environment, Ports, Image. Single-container sites: Environment, Ports, Image (recreated from inspect, as moves do). Decided (lead). |
| Editor | Compose is a text editor of the site's own files. Ports and Image are guided views that make the same text edit and show it in the diff; when the line cannot be found unambiguously (anchors, `${VAR}`, `extends`, several files define it) the tab says "Edit this in Compose". No YAML library is added. Decided (lead). |
| Secrets | Environment values are never sent to the browser. Rows show **Saved**; **Replace** takes a new value. Values travel browser to API to SSH stdin only, and are written 0600 with the original owner. Decided (lead). |
| Gate | An allow-list first (the move lists: an unknown key is refused), then the candidate is resolved on the server and compared with the current model; anything that adds privilege is refused, and services that already have host access are frozen (Security review changes, items 1-4). Decided (lead). |
| Order | Validate, backup, pull, maintenance on, write, gate again on the real files, `compose up -d --no-build --pull never`, health check, maintenance off. The pull happens before the maintenance page, so downtime is only the restart. Decided (lead). |
| Healthy | The restore test rules: every service that ran before runs, is Docker-healthy where it has a health check, still runs after 60 seconds, and the site's health URL (if set) answers 200-399 from the server. Time limit 2 minutes by default, 1-10 in Advanced. Decided (lead). |
| Rollback | Automatic on any failure after the first write: original files back (byte for byte, owner and mode), previous image IDs pinned, `compose up`, health check again. When an image changed, the site's data is put back from a server-local safety copy (see "Data safety copy" below; owner decision 1). |
| Rollback fails | The site stays behind the maintenance page, the edit becomes `needs_attention`, `edit.needs_you` alerts, and **Restore backup** offers the pre-change backup through the normal (isolated) restore. A data safety copy, if one was made, is kept on the server and the panel says so. Decided (lead). |
| Locks | A Safe Edit is a site job (`site-edit`, statuses `edit_queued`/`edit_running`): no backup, restore, move or other edit of the site runs at the same time; refused during an unfinished move and a deployment hold. Self-heal is paused for the site while it runs. Decided (lead). |
| Audit | `site.edit.requested`, `site.edit.applied`, `site.edit.rolled_back`, `site.edit.needs_attention`, with changed field names and file hashes only, never values. Decided (lead). |
| Schema | Migration `safe-edits`, next free number at merge (currently 13), `compatible: true`, new tables only. |

## Threat model

Safe Edit writes to production as root over SSH. Assets: the site's data and uptime, secrets in environment values and
Compose files, the host itself.

| Threat | Control |
|---|---|
| Stolen administrator session deploys a hostile image or command | Re-verification within 5 minutes at Apply; audit with actor; the gate below stops host escape (no privilege, host mounts, socket). Services that already have host access cannot get a new image, command, entrypoint or environment (item 4). A hostile image in an unprivileged service is the residual risk, the same as SSH access to that Compose file. |
| Compose injection: `privileged`, `cap_add`, `devices`, `pid/ipc/uts/userns: host`, `network_mode: host` or `container:`, `security_opt`, `sysctls`, `cgroup*`, a bind mount of `/var/run/docker.sock` or any path outside the site's application locations or under the protected list, `volumes_from`, external networks or volumes, volume driver options, file-based `secrets`/`configs` outside the project | Unknown keys refused by the allow-list; listed settings refused when the candidate adds them (comparison per service on the resolved JSON, not on text). Capabilities in Docker's default set are not "added" (the 2.13.5 rule). Also refused: `include:` of a new file, `extends` of a file outside the project, `env_file` outside the project or protected paths, a new `build:`. |
| Port grab | A new host port is refused when it is in use on the server or is 22 or the SSH port; binding a new port on all addresses shows an amber warning in Review ("Reachable from the internet"). |
| Secret leak | Values never in API responses, SQLite, job details, step detail, audit, alerts, logs, error text or the stored diff. The helper redacts Docker errors to command name and exit code (existing rule). The Compose editor may show inline secrets the file already holds: admin plus re-verification, `Cache-Control: no-store`, and an info panel "Move secrets to Environment" when secret-looking keys hold inline values. |
| Path tricks | Files written are only the site's saved Compose and configuration files, resolved with symlinks followed and checked against the protected list; written with `O_NOFOLLOW` through a temp file and `rename` in the same folder. A file whose inode or hash changed since the editor loaded it is refused at review ("This file changed on the server. Reload it.") and again at apply under the site lock. |
| Rollback correctness | Originals are copied into the edit journal before the first write; image IDs (not tags) recorded; the journal is the only source of rollback, never the browser. Rollback is idempotent and runs again after a worker restart. |
| Concurrent work | Site job plus partial unique index (one unfinished edit per site); `claimJob` keeps the server busy; restore tests are unaffected (they use their own names and labels on the test server). Self-heal ignores the site while the edit job exists. |
| Resource abuse | 10 edits per site per hour; files at most 256 KB each; at most 200 environment keys; values at most 8 KB. |

## Data model (migration `safe-edits`, `compatible: true`)

Next free number at merge time (currently 13; 2.14 may take it first, then renumber). New objects only.

- `site_edits(id PK, site_id → sites, server_id → servers, job_id → jobs, backup_id → backups ON DELETE SET NULL,
  state CHECK queued|running|checking|rolling_back|done|needs_attention|cancelled, result CHECK applied|rolled_back|failed|cancelled NULL,
  failed_step, reason CHECK length <= 300, changes CHECK length <= 4096 (JSON: tabs used, changed field paths such as
  `services.web.image`, env keys added/replaced/removed, before/after SHA-256 per file; never values),
  health_seconds, time_limit_seconds CHECK 60..600 DEFAULT 120, data_rollback 0/1, created_by, created_at, started_at, finished_at)`.
- `site_edit_steps(edit_id → site_edits, step CHECK backup|prepare|apply|check_health|finish|roll_back, state,
  started_at, finished_at, detail CHECK length <= 500, PRIMARY KEY(edit_id, step))`.
- Partial unique index `site_edits(site_id) WHERE result IS NULL`. Keyset index `(site_id, created_at, id)`.
- Triggers: refuse `DELETE`; refuse changing `result`, `failed_step`, `reason`, `changes` once `result` is set.
- The candidate files are never stored in SQLite. Between Review and Apply they live in memory in the API for 15
  minutes keyed by a one-use token, sealed with the master key; the worker receives them through the job's sealed
  `details.payload`, which is wiped (set to `{}`) when the `apply` step finishes or the edit ends.

## API (administrators, CSRF, `no-store`)

- `GET /api/sites/:id/edit` returns the editable view: Compose file texts with path, inode and SHA-256; environment
  keys per file with `set: true` (no values); ports and images per service from the resolved model; which tabs are
  usable and why not. Needs re-verification within 5 minutes because Compose text may hold secrets.
- `POST /api/sites/:id/edit/review` body `{ files?: [{path, sha256, text}], env?: [{file, key, value?|remove}] }`.
  Runs the gate on the server (helper `edit-check`), answers `{ token, diff, summary, warnings }` or 422 with one plain
  reason and `code` (`PRIVILEGE_ADDED`, `PATH_REFUSED`, `FILE_CHANGED`, `COMPOSE_INVALID`, `ISOLATION_FAILED`, `COMPOSE_UNDECLARED`, `SERVICE_REMOVED`,
  `PORT_IN_USE`). The diff masks environment values as `(changed)`.
- `POST /api/sites/:id/edit/apply` body `{ token, timeLimitSeconds? }`: 403 `REAUTH_REQUIRED`, 409 `SITE_BUSY` /
  `MOVE_RUNNING` / `EDIT_RUNNING`, else 202 `{ edit: { id } }`.
- `GET /api/site-edits/:id` (steps, state, result, reason; any signed-in user for its site), `GET /api/sites/:id/edits`
  (history, keyset paging), `POST /api/site-edits/:id/cancel` (only before `apply` starts).

## Worker and helper

A ticked step machine like moves (`src/site-edits/engine.js`, `tickSiteEdits()` in the worker tick). The backup step
queues a normal backup with actor `edit:<id>` and waits without holding the worker. `check_health` polls across ticks
like restore tests.

New helper module `remote/helper/edit.py` (added to `HELPER_MODULES`), operations take `editId` (UUID), hold a per-site
lock and stop when stdin closes:

| Operation | Step | What it does |
|---|---|---|
| `edit-check` | review | Read-only: the two-pass resolution of item 3 with the site's recorded Compose invocation, on the candidate files in a private temp folder; runs the gate, checks inode/hash, free ports. Deleted at once. Advisory only: `edit-apply` repeats the gate on the real files (item 5). |
| `edit-prepare` | prepare | Journal `/var/lib/docknest/edits/<editId>/` (root 0700): original files, owners, modes, hashes, current image IDs per service; pulls new images (`docker compose pull` of changed services only, time limit 15 minutes). |
| `edit-apply` | apply | Maintenance on (existing), re-check inode/hash, atomic writes, gate again on the real files, `docker compose up -d --no-build --pull never` (single containers: recreate from inspect with a 0600 `--env-file`). |
| `edit-poll` | check_health | Running, health, stability, health URL. `final: true` at the end of the window. |
| `edit-rollback` | roll_back | Originals back, services pinned to the image IDs held by the protective `docknest-edit/<editId>` tags, `compose up -d --no-build --pull never --remove-orphans`, with the data sets put back from the safety copy first when an image changed (owner decision 1), health check. Idempotent. |
| `edit-finish` | finish | Maintenance off, journal removed. |
| `edit-status` | recovery | What the journal holds and whether files match original or candidate. |

`VERSION` stays 1 (see remote-helper.md).

## Failure and rollback paths

- Fails in `edit-check` or `prepare` (pull failed, disk full, backup failed): nothing was written; result `failed`, no
  rollback needed, maintenance never turned on.
- Fails in `apply` or `check_health`: `roll_back` runs; result `rolled_back` with the reason ("The site did not become
  healthy in 2 minutes."), alert `edit.rolled_back`.
- `roll_back` itself fails: `needs_attention`, maintenance stays on, alert `edit.needs_you`, **Try again** (re-runs
  rollback) or **Restore backup** (normal restore of `backup_id`).
- Worker restart mid-step: the job is failed by `recoverInterruptedSiteEdits`; `edit-status` decides: files still
  original → `failed`; candidate written → `roll_back`.
- Server reboot during apply: containers come back with whatever files are on disk; the next tick runs `edit-status`
  and rolls back.
- Cancel: only before `apply`; afterwards **Cancel** is hidden and rollback is the undo.

## Security review changes (binding)

The security review (2026-11-02) tightened the design. Where this section and the text above differ, this section wins.

1. **Allow-list, then diff.** The gate starts from the move allow-lists in `remote/helper/move.py` (top-level, service
   and mount keys, network and volume checks): a key not on them is refused, even if the site had it. Only then is the
   "already had it" comparison applied. Explicitly refused when added: `use_api_socket`, `gpus`, `runtime`,
   `group_add`, `device_cgroup_rules`, `cgroupns`, `storage_opt`, `deploy.resources.reservations.devices`, new
   `logging` drivers, and any label under `docknest.*` or `com.docker.compose.*`.
2. **Environment cannot steer Compose.** Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; values may not hold CR, LF or NUL;
   keys starting `COMPOSE_`, `DOCKER_` or `BUILDKIT_` are refused. Every Compose call (check, apply, rollback) uses the
   same explicit `-p <project> -f <files...> --project-directory <dir>` recorded at review.
3. **Safe resolution.** First pass `docker compose config --no-interpolate --no-env-resolution --no-path-resolution`;
   `include`, `extends.file` and `env_file` paths are validated (inside the project, not protected, no symlink out)
   before the full pass. Remote includes off (`COMPOSE_EXPERIMENTAL_GIT_REMOTE=0`, `COMPOSE_EXPERIMENTAL_OCI_REMOTE=0`).
   Compose runs under `env -i` with a fixed `PATH`. The resolved JSON and Compose's stderr never leave the helper; the
   API receives only the gate verdict, field paths and a fixed reason.
   **Isolated view (#168).** Both passes over a candidate, and the re-gate at apply, run in a private mount and network
   namespace (`unshare --mount --net`, the launch sandbox technique; no image is pulled, so it works offline).
   `/srv`, `/opt`, `/mnt`, `/media`, `/home`, `/root`, `/run`, `/tmp`, `/var/log`, Docker's and DockNest's state are
   empty tmpfs mounts; only the site's folders, its Compose and env files, the check folder, the files the current
   model already reads (`env_file`, file secrets and configs) and the Compose plugin folders are bound back,
   read-only. No network, no Docker socket. The site's current files still resolve on the host (they define what the
   site already has). Without `unshare`/`mount`, or when the current files do not resolve in the view (for example an
   `include` from outside the site's folders), every tab says `ISOLATION_FAILED` and nothing is edited (fail closed).
   **Declared names.** The resolved `services`, `volumes`, `configs` and `secrets` of the candidate must be names its
   own files declare at the top level (JSON exactly, block YAML by indentation; a section written another way counts
   as declaring nothing). A name that is not declared is refused with `COMPOSE_UNDECLARED`, unless the current files
   already resolve the same undeclared name (an existing `include` or merge keeps working). The text rules stay as the
   first layer.
4. **Dangerous services are frozen.** A service that already has host-escape settings (`privileged`, host
   namespaces, `docker.sock`, a bind of `/` or a protected path, added capabilities beyond Docker's defaults) cannot get
   a new image, command, entrypoint or environment through Safe Edit: "This service has host access. Change it by hand."
5. **Gate again at apply.** `edit-apply`, under the site lock, re-checks inode and hash of every original, writes, runs
   the gate on the real files in the real folder, and runs `up` only when the result equals the reviewed one; otherwise
   it restores the originals and fails with "The files changed during the backup."
6. **Bind sources by realpath.** Every bind source is resolved at review and again at apply; a symlink in any component
   is refused; a new bind must be inside a folder the site already binds; nested read-write binds across services are
   refused.
7. **Rollback cannot re-pull.** Apply and rollback use `up -d --no-build --pull never`. `edit-prepare` tags every
   current image ID as `docknest-edit/<editId>:<service>` (for retagging) and creates one never-started holder container
   per image (`docknest-edit-hold-<editId>-<hash>`, label `docknest.edit.hold`, outside the Compose project, `--network
   none`), because tags alone do not survive `docker image prune -a`. `edit-finish` removes the holders (with their
   anonymous volumes) and the tags. A `docker container prune` or `docker system prune` removes the holders too; rollback
   then fails closed (needs attention, maintenance page stays). Corrected after review, 2026-11-02.
   Rollback runs with `--remove-orphans` (scoped by `-p`) and removes volumes and networks the journal records as
   created by the candidate.
8. **No secrets in argv.** Single-container recreates pass environment through a 0600 `--env-file` in the journal
   folder, removed after create. A Python test asserts no value appears in any argv.
9. **Older releases.** `edit_running` joins the busy predicate in `CLAIMABLE_JOB_SQL`. Because 2.14.x cannot see it,
   the downgrade path in `scripts/upgrade.sh` refuses while a Safe Edit is unfinished (a preflight check, not only a
   note in `upgrading.md`).
10. **Token binding.** The review token is bound to user, session, site and the original hashes, is one-use, expires in
    15 minutes, and Apply still needs the 5-minute re-verification. `GET /edit` and review responses are excluded from
    request logging and problem reports.
11. **Docker environment.** Compose runs under `env -i PATH=<fixed> HOME=/root` (or an explicit `DOCKER_CONFIG`), so
    registry logins and credential helpers keep working; no proxy or other variables pass.
12. **Freeze on the resolved model.** Item 4 is decided on the resolved-model diff of the frozen service (image,
    command, entrypoint, environment), so changing `IMG` in `.env` for `image: ${IMG}` is refused too.
13. **One recorded invocation per site.** The full Compose invocation (`-p`, every `-f`, `--project-directory` and
    `--env-file`, as Launch records it) is stored with the site and reused by check, apply and rollback.
14. **Minimum Compose.** The resolution flags of item 3 need Compose 2.24 or newer (the move override already needs
    it); older Compose is refused at review with "Update Docker Compose to 2.24 or newer."
15. **Downgrade wait.** The `jobs-did-not-finish` wait in `scripts/upgrade.sh` counts `edit_*` and `heal_*` in 2.15.0.
    The launch job statuses do not exist yet; 2.16.0 adds them to the same wait when it introduces them.
16. **Extra Linux cases:** newline and `COMPOSE_FILE` injection through environment; `env_file: /etc/shadow` not leaked
    in the 422 text; `use_api_socket`; label spoofing; rollback with `pull_policy: always`; `docker image prune` between
    prepare and rollback; orphan removal; symlinked bind source; a hand edit during the backup step; image change on a
    `docker.sock` service refused.

## Data safety copy (owner decision 1, approved 2026-11-02)

The normal restore only creates an isolated copy, so data rollback does not use the pre-change backup. Instead, when the
reviewed change replaces an image, `edit-apply` makes a server-local safety copy after the maintenance page is on and the
site's services are stopped: every data set the site's backup covers (local named volumes and the bind data folders in
the backup config, not the Compose or configuration files, which the file journal covers), with owner, mode and
symlinks preserved, into `/var/lib/docknest/edits/<editId>/data/`. It is refused before any write when free disk space
on that filesystem is below 1.2 times the data size ("Not enough free disk space for the safety copy."), and at review
when a volume uses a non-local driver. Rollback stops the services and replaces each data set exactly from the copy
before the pinned `up`. The copy is deleted after a successful change and after a successful rollback; when rollback
fails it is kept, and the "needs attention" state says so. Env-only and port-only changes make no copy.

## Upgrade safety

- Migration is additive; no settings row means nothing changes for existing sites. Rolling back to 2.14.x opens the
  database (floor unchanged) but cannot see `edit_*` jobs, so the downgrade preflight in `scripts/upgrade.sh` refuses while a Safe Edit is unfinished (item 9); `upgrading.md` says so too.
  A server left mid-edit after such a rollback keeps its journal; the next 2.15 start rolls it back.
- Existing alert lines do not gain the new events.
- Upgrade fixture: a 2.14 database; exact preservation and idempotence asserted.

## Test plan

- Unit/API: gate comparison table (every refused key added vs. already present), Docker default capabilities,
  redaction of the diff, token expiry and one-use, roles and re-verification, rate limit, step machine and restart
  recovery, unique index, triggers, migration from a 2.14 fixture.
- Python (`remote/test_edit.py`): atomic write keeps owner/mode, `O_NOFOLLOW`, inode/hash refusal, journal before
  write, rollback idempotent, env file edit keeps comments, order, quoting and `export` lines.
- Browser: editor, environment table (Saved, Replace), Ports/Image guided edits and "Edit this in Compose", Review
  diff and warnings, timeline in each state, rolled back and needs-attention panels; 1280 and 390, light and dark.
- Linux integration (`scripts/integration-safe-edit.js`, CI `linux-integration`, Docker 28+):
  1. Image tag upgrade that passes; the old image ID stays on disk until the next prune.
  2. Image tag to a version whose health check fails: rolled back, original files byte-identical, old image ID running.
  3. Env value change that makes the app exit after 20 s: fails at stability, rolled back.
  4. Port change to a port in use: refused at review, nothing written.
  5. Candidates adding `privileged`, `docker.sock`, `/etc` bind, `network_mode: host`: refused.
  6. Kill the worker during `apply`: next worker rolls back.
  7. Rollback itself made to fail (journal file corrupted in the test): `needs_attention`, maintenance page served.
  8. Single-container site: env and port change by recreate.
  9. Image change with a database migration on start, then failing health: data rollback behaviour as decided.

## Real and unusual use cases

- Bump `wordpress:6.5` to `6.6`; bump a pinned digest; switch `latest` to a fixed tag.
- Rotate a database password in `.env` (both the app and the database read it); rotate an SMTP password.
- Move a site from port 8080 to 8081 because another app needs 8080.
- Several Compose files (`compose.yaml` + `compose.override.yaml`); the port lives in the override.
- `image: shop:${TAG}` with `TAG` in `.env`: Image tab says "Edit TAG in Environment".
- YAML anchors shared by two services; `extends` from a common file in the project.
- `.env` with comments, `export KEY=`, quoted values with `#`, CRLF line endings, a missing final newline.
- No health check and no health URL: only "running and stable" counts; Review says so.
- The site is already in maintenance; the edit keeps it on afterwards.
- A registry rate limit or private registry login failure during pull: fails before any write.
- Server disk too full for the pre-change backup: refused at backup; too full for the data safety copy: refused before any write.
- The file was edited by hand over SSH between load and Apply: refused, reload.
- Adding a Redis service to an existing project; removing a service: refused.
- DockNest's own site (self-backup host): refused, it would stop the dashboard.

## Owner questions (decided 2026-11-02, all recommendations accepted)

1. **Data rollback.** When a change fails after the new version ran, should rollback also restore data volumes from the
   pre-change backup? The site is behind the maintenance page during the change, so no visitor writes are lost.
   Recommendation: automatic only when an image changed (new versions run database migrations), never for env or port
   changes; shown in Review as "Data rollback: Yes".
   **Decided:** data rollback only when an image changed, from a server-local safety copy (see "Data safety copy").
2. **Maintenance page.** Show the maintenance page during every change, or only when an image changes? Recommendation:
   every change, it is a few seconds and keeps data rollback safe.
   **Decided:** the maintenance page for every change.
3. **Operators.** Should operators be able to change environment values and image tags (not Compose text)?
   Recommendation: no for 2.15, admins only; revisit with an "Operators can edit sites" switch later.
   **Decided:** administrators only.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the step machine, rollback and trade-offs,
[Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md)
for the privilege gate and secret handling, and
[UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md) for the editor,
review and timeline boards.
