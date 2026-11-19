# 3.0.0 design: domains, keys safe, "if I'm gone" and small ideas

Status: draft for owner review. Design only; no product code is in this change.

3.0.0 ships as one major release on `integration/2.16.5` (the branch name stays). It contains the 2.16.5 work (Apps
rename, duplicate-free coverage in `shared/backup-coverage.js`, back up any container, restore check, MongoDB and
engine modules, linked apps on the Map, Map free drag), the design-system v2 redesign, and the work designed here.
This design builds on the 2.16.5 work and does not repeat it. All copy says "app".

Decision records:

- [Domains on the Map](adr-3.0.0-domains-map.md) (theme 1)
- [Keys safe](adr-3.0.0-keys-safe.md) (theme 2)
- ["If I'm gone": runbook and emergency kit](adr-3.0.0-if-im-gone.md) (theme 4, security-critical, with a threat model)
- The small ideas are designed in [Small ideas](#small-ideas) below.

Mock boards are real-app renders (Vite plus fixture data, light and dark, 1280 and 390). They live outside Git with
the owner's review copy. They use the current tokens. The UI build PRs come after the design-system v2 token and
component PRs, so the built screens use the v2 tokens.

## A. Audit

Evidence is `file:line` on `origin/main` (75aa661) unless a branch is named. EXISTS means usable as is, PARTIAL means
a part exists and is extended, NEW means nothing usable exists.

### Theme 1: Domains on the Map

| Item | State | Evidence | What to improve |
|---|---|---|---|
| nginx route discovery | EXISTS | `remote/helper/discovery.py:23` `nginx_sites()` returns domains, upstreams and static roots, never file contents | Reuse it as the nginx adapter. Add `listen` ports and `ssl_certificate` names, which the restore check already reads (`restore_gaps.py:280`, `feat/restore-check`). |
| Domain to container match | PARTIAL | `discovery.py:71` `web_hints()` matches only loopback `proxy_pass` to published ports 80/8080/3000/5173/8000/5000/5678 | Match any published port and Docker network upstreams (`http://shop-web:8080`). This is shared by all proxy adapters. |
| Caddy, Traefik, Nginx Proxy Manager | NEW | no match for caddy, traefik or proxy_manager under `remote/helper/` | Add read-only adapters: the Caddy admin API, Traefik Docker labels, and NPM's generated nginx files. See the ADR. |
| Certificates | EXISTS | `remote/helper/net.py:247` `certbot_certificates()` reads public certificate files only; `net.py:205` `certificate_fact`; `src/alerts/certificates.js:66,133` stores facts in `site_certificates` (`src/migrations.js:238`) and raises expiry and renewal alerts | Reuse as the Certificate hop. Add a renewal failure *category* from the certbot log (connection refused, timeout, DNS problem, rate limit). Only the category is kept, never log text. |
| Public DNS lookups | EXISTS | `src/moves/dns.js:4-26` fixed public resolvers, `dns.js:52` `checkDns`, `dns.js:46` Cloudflare proxy ranges | Reuse it for the DNS hop. Add the "points at none of your servers" and CGNAT reasons. |
| Cloudflare client | EXISTS | `src/moves/cloudflare.js:59` `zoneFor`, `:63` `records`, `:98` `pointsAt` | Add a read-only token check that reports an expired or limited token as a plain reason. Records stay read-only here. |
| Probe policy (SSRF) | EXISTS | `src/probe-url.js:5-16`, helper `net.py:132` `probe_policy_preflight`, `net.py:158` `probe_url` | The App hop's HTTP probe goes through this unchanged. No new outbound path. |
| Maintenance health URL | EXISTS | `src/probe-url.js:20`, `src/server.js:115,142` | It is one more URL for the App hop. It is not a domain source. |
| Map nodes and edges | PARTIAL | `web/map/layout.js:24` "No DNS data is available"; `docs/design/DESIGN.md:48` "Only servers, sites and storage are nodes" | Amend the Map rule: domains become nodes in a left column (ADR). Add a server in-port. |
| Domains in app details | EXISTS | `web/map/MapPage.jsx:395` lists `domainsOf(s)` as links | Replace the list with a "Domains" section that shows each domain's worst hop. |
| Move warning for domains | PARTIAL | `src/moves/preflight.js:158` blocks only when the target already serves a domain; `:175-179` checks DNS for `site.domains[0]` only | List every domain that breaks, including domains other servers' proxies send to this app. |
| Domains that point nowhere | NEW | nothing joins DNS answers with server addresses outside a move | Add a "Points nowhere" group (ADR). |

### Theme 2: Keys safe

| Item | State | Evidence | What to improve |
|---|---|---|---|
| App encryption key detection | NEW | no match for APP_KEY, N8N_ENCRYPTION_KEY or SECRET_KEY_BASE in `src/`, `remote/`, `shared/` or `web/` | Add a rule list in `shared/key-rules.js` (ADR). |
| Value-free fingerprints | PARTIAL | the helper hashes files (`backup.py:42-65,272-289`) and plans (`backup.py:165`); the server masks env (`src/server.js:237`, `src/moves/preflight.js:43`) | Add keyed fingerprints (HMAC with an install key from HKDF), never a plain hash of a secret. |
| Proof that keys are in the backup | NEW | the manifest carries the env (`guides.py:10`), but nothing checks that a named key is present | The helper fingerprints the bytes it writes into the package. A restore test confirms them in the restored copy. |
| Changes outside Safe Edit | NEW | Safe Edit hashes only its own candidate and reviewed model (`src/site-edits/engine.js:213,272-279`) and never keeps a baseline | Add stored fingerprints, a silent first baseline, and Safe Edit apply as known-good. |
| Move ownership, modes and bind paths | PARTIAL | `remote/helper/move.py:280` lists existing target paths; `:342` refuses a non-empty target; `preflight.js:101` requires root. Restore check kinds (`docs/restore-check.md`, `feat/restore-check`) have no ownership, mode or filesystem kind | Add `owner-map`, `file-mode` and `target-filesystem` finding kinds in the restore check vocabulary. The Move preview asks the target for them, so nothing is duplicated. |
| Recovery kit decrypt proof | NEW | `src/recovery-kit.js:40,63` export and restore exist; the self-backup stores the passphrase sealed (`src/self-backup.js:19,39`); the self-backup docs list no kit open check | Open the newest kit after every self-backup, in the worker, in a 0700 temp folder. |
| Padlock on the Map and on the card | NEW | — | Covered by the boards. |

### Theme 4: "If I'm gone"

| Item | State | Evidence | What to improve |
|---|---|---|---|
| Restore guide texts | EXISTS | `remote/helper/guides.py:7` `RESTORE_GUIDE`, written into every package (`backup.py:662`) | These are written for experts. The runbook adds plain steps and links to them. |
| Recovery kit | EXISTS | `src/recovery-kit.js:8` (state, master key, tools), scrypt N=32768 (`:10`) | The emergency kit reuses this format. Only the envelope is new. |
| Verification evidence | EXISTS | `src/recovery-evidence.js:5,15,24` | The runbook uses this wording source. "Verified" appears only with restore test evidence. |
| Self-backup | EXISTS | `src/self-backup.js` | A new emergency kit is made with each self-backup. |
| Runbook, out-of-date flag | NEW | — | ADR. |
| K-of-N split | NEW | no match for shamir or split secret | ADR (SLIP-0039 plus X25519). |

### Small ideas

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | Missed-run alert | PARTIAL | `src/engine.js:570` keeps a missed occurrence due and coalesces it silently; `:574` audits an invalid schedule only; `src/alerts/events.js:8` has no missed-run event |
| 2 | Restore test from the off-site copy | PARTIAL | an isolated restore already takes `sourceTargetId` (`src/engine.js:145,194-195`); a restore test always passes `null` (`src/restore-tests/engine.js:310`) |
| 3 | Import from Portainer or Dockge | NEW (Dockge mostly works already) | Dockge runs Compose on host paths, so `project_roots` (`discovery.py:9-22`) accepts its stacks. Portainer's `working_dir` label is a path inside the Portainer container (`/data/compose/N`), so `is_dir()` fails and the stack has no config files |
| 4 | Online logical DB dumps | NEW | every engine stops cleanly and copies files (`databases.py`; one module per engine on `feat/mongodb-engine`, `engine_base.py`); only SQLite has an online integrity check (`databases.py:35`); the Redis `DUMP` (`engine_redis.py:165`) checks one key only |
| 5 | Append-only SFTP | NEW | S3 Object Lock exists (`src/storage/s3.js:93,116,166`); SFTP has no write-once mode, and publishing renames a temp file |

## Small ideas

1. **Missed run.** A new `backup.missed` event fires when a due occurrence has not started 60 minutes after its time
   (or half the schedule period, if that is shorter). The scheduler tick that already runs checks this, and so does the
   worker on start after an outage. There is no new timer. The alert is sent once per occurrence (`policies.missed_alerted_run`,
   a compatible column). The reason is plain: "the worker was offline from 01:40 to 06:10" comes from the worker lease
   history; otherwise "the app was busy with a move" or "the schedule is invalid". The app card and Overview show a
   red StatusLabel until the next run starts.
2. **Restore test from the copy.** The restore test settings gain "Test from": main storage or one verified copy.
   `testTransport.upload` passes that `sourceTargetId`, which the isolated restore already supports. If the copy is
   missing or failed, the test ends as "couldn't run" with the copy's name. It is never a silent fall back to main.
   The evidence records the source role, so the runbook can say "tested from the off-site copy".
3. **Import from Portainer or Dockge.** Discovery labels stacks by origin. Dockge: compose projects under its stacks
   folder (from the Dockge container's `DOCKGE_STACKS_DIR` env and mount). Portainer: the helper maps
   `/data/compose/N` to the host source of the Portainer container's `/data` mount. The stack's Compose and `.env`
   then become configuration files, with the same path rules. "Add all" creates one app per stack through the normal
   add flow. Containers that another app already backs up stay hidden (2.16.5 coverage). DockNest never talks to
   Portainer's or Dockge's API, and needs no login to them.
4. **Online logical dumps (opt-in per database).** This is an optional method on the engine module interface
   (`engine_base.py`):
   - PostgreSQL: `pg_dump -Fc` inside the container (one snapshot transaction).
   - MySQL and MariaDB: `--single-transaction`. DockNest refuses when a non-InnoDB table exists.
   - MongoDB: a single-member replica set with `--oplog` only. A standalone server is refused, because its dump is not
     point-in-time.
   - Redis: stays on its current method.

   The clean stop plus file copy stays the default. The proof wording says "logical dump", and only a restore test
   that loads the dump counts as Verified.
5. **Append-only SFTP.** A storage option. DockNest writes each package once, under its final unique name, with
   exclusive create, then reads it back for the hash. It never removes or renames, and retention is off for that
   target. When connecting, a test file must be refused for delete and rename, or the option cannot be saved.
   OpenSSH `sftp-server -P remove,rmdir,rename,posix-rename` is the documented server setup. An upload that fails
   halfway leaves a file DockNest cannot delete. That file is recorded as failed, and the storage report counts it.

## D. Build split (after the design-system v2 token and component PRs)

Leads follow the team rules: one combined reviewer per PR, and Opus for the security-critical leads. Every PR updates
docs, README and CHANGELOG (Unreleased) and carries one migration at most. Backup, restore and Move PRs run the Linux
Docker integration suite.

| Lead | PR | Content | Depends on |
|---|---|---|---|
| L1 Domains (Opus: DNS, probes) | 1 | Helper proxy adapters (nginx extended, Caddy, Traefik, NPM) and the upstream matcher, with Python tests | 2.16.5 engine modules |
| | 2 | Domain path engine, `domain_checks` migration, API, the Move preflight listing every domain | PR 1 |
| | 3 | Map UI: Domains column, path panel, app Domains section (Sonnet frontend) | PR 2, DS v2 |
| L2 Keys safe (Opus) | 4 | `shared/key-rules.js`, install fingerprint key (HKDF), helper detection, proof in the backup, `app_keys` migration | 2.16.5 |
| | 5 | Config fingerprints, silent baseline, `config.changed` event, Safe Edit known-good, `config_fingerprints` migration | PR 4 |
| | 6 | Move ownership, mode and filesystem kinds in the restore check vocabulary | restore check (#204) |
| | 7 | Kit decrypt proof after each self-backup, `kit_checks` migration | — |
| | 8 | UI: padlock, Keys panel, card line, kit check card | PRs 4, 5, 7, DS v2 |
| L3 If I'm gone (Opus) | 9 | `src/emergency/` SLIP-0039 split and join, X25519 envelope, published test vectors. No UI | — |
| | 10 | Emergency kit with each self-backup, `emergency_keys` migration, offline open tool in the recovery kit | PR 9 |
| | 11 | Runbook generator, inventory digest, Runbook page, in-house PDF writer (`src/runbook/pdf.js`, vendored fonts) and the recovery guide dialog | PRs 7, 10 |
| | 12 | Split flow and practice join UI | PRs 10, 11, DS v2 |
| L4 Small ideas (Sonnet, PR 16 Opus) | 13 | Missed-run event | — |
| | 14 | Restore test from a copy | — |
| | 15 | Portainer and Dockge import | 2.16.5 coverage |
| | 16 | Append-only SFTP (storage integrity) | — |
| | 17 | Online dumps, one engine per commit | engine modules (#206) |

### Migration plan

Every change is additive and `compatible: true`, so a rollback to an earlier 3.0 build ignores it. The numbers are
assigned at merge time, in merge order, after the last 2.16.5 migration (19 is `site-restore-decisions`; linked apps
and container adoption take the next ones). Tables: `domain_checks`, `app_keys`, `config_fingerprints`, `kit_checks`,
`emergency_keys`, `runbook_state`. Columns: `policies.missed_alerted_run`, restore test settings `source_target_id`,
storage targets `append_only`. Online dumps live in the app's config JSON, so they need no migration. First-run rules:
- Fingerprints start as a silent baseline, so an upgrade raises no alerts.
- Missed-run checks look only at occurrences due after the upgrade.
- The runbook starts as "never made".
- The upgrade compatibility job (`npm run test:upgrade`) gains a fixture from 2.16.5 for each table.

## E. Owner decisions (approved)

The owner approved all six recommendations:

1. The Domains column shows by default when an app has domains. A toolbar toggle is remembered per browser.
2. Broken domain hops show on the Map and in the Move review only. There is no new alert; certificate alerts stay.
3. Only administrators can "Mark as known-good". They must re-verify, and it is audited.
4. The runbook offers a "type your own passphrase" practice, checked in memory and never stored. It is offered, never
   pushed.
5. Emergency kit parts are SLIP-0039 word lists of 33 words.
6. Append-only SFTP turns retention off for that storage, and the storage report warns about growth. Online dumps
   stay opt-in per database.

Theme 4 additions from the owner:

- A "Start here" section and a restore order.
- A "Download recovery guide (PDF)" text link that opens an options dialog (apps, addresses, admin-only login
  details, history, schedules, notes).
- A real server-side PDF.

All of this is in the [theme 4 ADR](adr-3.0.0-if-im-gone.md).

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
- [Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md): extending the existing modules rather than adding parallel scans.
- [Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md): fingerprints, the threat model and the emergency kit.
- [UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md): the boards.
- [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md): the "Verified" wording.

Subagents rendered the boards from the real UI with fixture data.
