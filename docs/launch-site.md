# Launch a new site from the Map (ADR, issue #151)

Status: proposed design for 2.16.0 "Launch", awaiting owner approval. Date: 2026-11-02. No code yet.
Builds on [moving-sites.md](moving-sites.md) (deploy journal, Compose allow-list, nginx and certificate steps, install
on server), [restore-tests.md](restore-tests.md), [safe-edit.md](safe-edit.md) (the privilege gate) and
[alert-channels.md](alert-channels.md) (Connections, sealed secrets).

The "+" beside a server on the Map offers **New site**. The owner gives a Compose file or a Git repository and a domain.
DockNest checks the server, deploys the site, sets up nginx and a certificate (offering to install missing tools with
the existing install flow), and turns on backups and restore tests from the first day.

Real launches count as validated only when the Linux integration test below passes (see AGENTS.md). Until then the
feature ships with the "beta" label.

## Goals

- From nothing to a backed-up, tested, HTTPS site in one flow, on a server DockNest already manages.
- A failed launch leaves the server exactly as it was.
- Private repositories through a deploy key that DockNest generates and keeps sealed.
- No new way to get root on the server from a Compose file or a repository.

## Non-goals

- No CI/CD: no webhooks, no deploy on push, no automatic pulls (later work could use Safe Edit for updates).
- No registries with logins in 2.16 (public images and images built from the repository only).
- No Kubernetes, Swarm, Helm or Dockerfile-only repositories (a Compose file must exist).
- No Git submodules, no Git LFS.
- No multi-domain or wildcard certificates; one domain plus an optional `www.` alias.
- No DNS hosting beyond the existing Cloudflare token from moves.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Who | Administrators, re-verification within 5 minutes at **Launch** and when creating a deploy key. Decided (lead). |
| Sources | (a) Compose file pasted or uploaded, plus optional environment values; (b) Git repository over `https://` (public) or SSH (`git@host:path`, `ssh://`) with a deploy key, a branch or tag, and the Compose file path inside it. Decided (lead). |
| Where it lives | `/srv/docknest/<slug>` on the server (an application location under the moves rules); refused if it exists. Compose project name `<slug>`. Decided (lead). |
| Fetch | On the server with `git` (offered through the existing install flow, `git` added to its fixed package table). Decided (lead). |
| Deploy key | A **Deploy key** in its own table, listed on the Connections page in its own section: DockNest generates an ed25519 key pair, shows the public key to paste into the Git host, seals the private key with the master key. The Git host's SSH key is read from the server's network view and confirmed by SHA-256 when the key is created (item 10). Deploy keys are always admin-only, never covered by "Operators can manage alerts". Decided (lead). |
| Build | Allowed when the Compose file has `build:`, with the build gate below, a 30-minute time limit and a free-space check. Owner question 1. |
| Gate | The resolved Compose model (`docker compose config --format json`) must pass the Safe Edit privilege gate with no "before": nothing privileged, no host namespaces, no `docker.sock`, bind mounts only inside the site folder, named volumes allowed, published ports only on `127.0.0.1` (nginx fronts the site). Decided (lead). |
| Web service | The owner picks the service and container port that nginx proxies to; DockNest binds it to a free `127.0.0.1` port through a generated override (as moves do, needs Compose 2.24+). Decided (lead). |
| nginx and certificate | The move steps: an nginx site file journalled in `/etc/nginx/sites-available` or `conf.d` (by distribution), `nginx -t` before reload, certbot `--nginx` once DNS points at the server. Without certbot, the existing **Install certbot** offer; without DNS, the site launches on HTTP and the certificate step waits for **Check again**. Decided (lead). |
| DNS | Cloudflare (existing token) can create the A/AAAA record; otherwise DockNest shows the exact record. Decided (lead). |
| Day one | The site record is created with its containers, Compose files and configuration files; a daily backup policy at a quiet time; the first backup runs as the last step. Restore tests weekly on the chosen test server; with no other server, they stay off with "Add a test server to turn on restore tests". Decided (lead). |
| Failure | Every created thing is journalled before creation (the `deploy-restore` pattern); any failure before the site is saved tears down all of it. Decided (lead). |
| After launch | It is a normal site (Safe Edit, self-heal, moves). **Remove launch** is offered for 24 hours: tears down what the launch created, keeps the first backup. Owner question 3. |
| Locks | One launch per server at a time; holds the server like an install (no backup, restore, move, install or restore test step there while a launch step runs). Decided (lead). |
| Schema | Migration `site-launches`, next free number at merge (currently 15), `compatible: true`, new tables only. The same migration adds the `deploy_keys` table (see Security review changes, item 10). |

## Threat model

| Threat | Control |
|---|---|
| Arbitrary code from a repository builds and runs as root on the server | The trust warning before **Launch** ("This builds and runs code from the repository on {server}. Only use repositories you trust."); admin plus re-verification; the runtime gate keeps containers unprivileged; the build gate below keeps builds unprivileged. Residual: a hostile repository runs code inside an unprivileged container with network access, like any `docker compose up` the owner would run. |
| Build escape | Build settings allow-list: `context` and `dockerfile` inside the repository after resolving symlinks (no URL or `..` contexts), `args`, `target`, `labels`, `platforms`. Refused: `network`, `extra_hosts`, `privileged`, `entitlements`, `ssh`, `secrets`, `cache_from`/`cache_to`, `additional_contexts`. BuildKit is run without extra entitlements. |
| Git URL tricks (SSRF, local files, `ext::`, option injection) | Only `https://` and SSH forms; the host must be a DNS name or public IP after the server resolves it (private and metadata addresses refused unless "Allow private address" is ticked for a self-hosted Git server, admin only); no leading `-` anywhere; argv only, no shell; the clone argv, environment and IP pinning of Security review changes items 2 and 3, with `core.hooksPath=/dev/null`, `--depth 1 --single-branch --no-recurse-submodules`, and after `env -i` explicitly `HOME=<journal folder>`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`. Size cap 2 GB and 10-minute time limit. |
| Repository content tricks | After clone, any symlink whose realpath leaves the repository refuses the launch (item 4); `.git` is removed after the checkout commit is recorded; setuid bits cleared (existing restore rule). |
| Deploy key theft | Private key sealed with the master key, never returned or logged; sent over SSH stdin and written to a 0600 file in the 0700 journal folder only for the clone, then removed (also on failure, and by teardown); the `GIT_SSH_COMMAND` of item 3. The public key is read-only on the Git host by the owner's choice; the UI says "Add it as a read-only deploy key". |
| Secrets in environment values | As Safe Edit: write-only, written to `/srv/docknest/<slug>/.env` 0600 root, never stored or logged. |
| nginx takeover of another site | Refused when any existing nginx server block already serves the domain; the file name is DockNest's own (`docknest-<slug>.conf`); `nginx -t` must pass, else the file is removed and the reason shown. |
| Port and name collisions | A Compose project, container, volume or network name that exists is refused (item 5); the loopback port is chosen free at check and re-checked at start. |
| Concurrent jobs | Server hold as above; the new site exists in DockNest only after the deploy passed, so no backup can run against a half-made site. |
| Resource abuse | 3 launches per server per hour; free space for clone plus images plus 2 GB checked before fetch. |

## Data model (migration `site-launches`, `compatible: true`)

Next free number at merge time (currently 15, after Safe Edit and self-heal). New objects only.

- `site_launches(id PK, server_id → servers, site_id → sites NULL (set when saved), slug CHECK length 1..40,
  source CHECK compose|git, repo_url CHECK length <= 512 NULL, ref CHECK length <= 200 NULL, commit TEXT NULL,
  compose_path CHECK length <= 300 NULL, deploy_key_id → deploy_keys NULL ON DELETE SET NULL, domain CHECK length <= 253,
  web_service, web_port, loopback_port, state CHECK queued|running|waiting_dns|done|failed|cancelled|removed|needs_attention,
  failed_step, reason CHECK length <= 300, created_by, created_at, started_at, finished_at, remove_until)`.
  The pasted Compose text and environment values are never stored here (sealed job payload, wiped after `deploy`).
- `site_launch_steps(launch_id, step CHECK check|fetch|build|start|check_health|web|certificate|save|first_backup,
  state, started_at, finished_at, detail CHECK length <= 500, PRIMARY KEY(launch_id, step))`.
- Partial unique indexes: `site_launches(server_id) WHERE state IN ('queued','running')` and
  `site_launches(server_id, slug) WHERE state NOT IN ('failed','cancelled','removed')`.
- Triggers: refuse `DELETE`; `reason` and `failed_step` fixed once set.

## API (administrators, CSRF)

- `POST /api/servers/:id/launch/check` `{ source, compose?|repo?, domain, webService?, webPort? }`: reads the server
  (`launch-facts`: tools, Docker and Compose versions, free space, ports 80/443, existing nginx domains, DNS answer)
  and, for Git, does a `git ls-remote` only. Answers checks in the move shape, each blocking tool with the existing
  `install` field (now also `git`), and the list of services and ports found.
- `POST /api/servers/:id/launch` `{ ...same, env?, testServerId?, backupTime? }`: 403 `REAUTH_REQUIRED`, 409
  `SERVER_BUSY`/`LAUNCH_RUNNING`/`SLUG_EXISTS`, 422 gate codes as Safe Edit, else 202 `{ launch: { id } }`.
- `GET /api/launches/:id`, `POST /api/launches/:id/cancel` (before `start`), `POST /api/launches/:id/check-dns`,
  `POST /api/launches/:id/remove` (within 24 hours, re-verification).
- Deploy keys: `POST /api/deploy-keys` `{ name, gitHost, serverId }` generates the pair and pins
  the host key; answers the public key and fingerprint once more on `GET` (public, safe to show).

## Worker and helper

A ticked step machine (`src/launches/engine.js`, `tickLaunches()`), server-touching steps as short `launch` jobs with
their own statuses (`launch_queued`/`launch_running`) stored like installs (no site yet). `check_health` and
`waiting_dns` release the worker between checks.

Helper module `remote/helper/launch.py`:

| Operation | Step | What it does |
|---|---|---|
| `launch-facts` | check | Read-only facts; `git ls-remote` with the same argv rules. |
| `launch-fetch` | fetch | Journal `/var/lib/docknest/launches/<id>/` (0700), site folder (journalled first), clone or write the pasted Compose file and `.env`; records the commit. |
| `launch-build` | build | `docker compose build` with the gate checked first; only images it creates are journalled. |
| `launch-start` | start | Generated override (loopback port, labels `docknest.launch=<id>`), `docker compose up -d --no-build`. |
| `launch-poll` | check_health | The restore test "passed" rules plus an HTTP check on the loopback port. |
| `launch-web` | web | nginx file, `nginx -t`, reload. |
| `launch-certificate` | certificate | The existing `move-certificate` code path. |
| `launch-teardown` | failure, remove | Removes only what the journal lists and the label confirms, never `-f` on images; the first backup is kept. |
| `launch-status` | recovery | What is left. |

Install flow: `git` joins the fixed table (`git` on apt and dnf), with the same rules as nginx.

## Failure and rollback paths

- Any step before `save` fails: teardown runs, launch `failed` with the step and reason; the server is as before.
  Teardown failure: `needs_attention`, server hold kept, alert `launch.needs_you`, **Try again**.
- DNS not pointing yet: state `waiting_dns` after `web`; the site is saved and backed up; **Check again** runs the
  certificate step; nothing polls.
- Certificate fails (rate limit, CAA): the site stays on HTTP, saved; the step shows the reason and **Try again**.
- Worker restart: interrupted job failed; `launch-status` decides between resume and teardown, as moves do.
- Remove launch (24 hours): teardown plus the site record archived (backups kept, schedules off).

## Security review changes (binding)

The security review (2026-11-02) tightened the design. Where this section and the text above differ, this section wins.

1. **Builds without host network.** Builds run on a dedicated `docker-container` buildx builder created by the launch
   (journalled, removed at the end) with no entitlements, so `RUN --network=host` and `--security=insecure` fail.
   Dockerfiles are also scanned and refused for those flags. A `# syntax=` line must name `docker/dockerfile` (any
   tag); others are refused.
2. **Git transport locked down.** `-c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always
   -c http.followRedirects=false -c submodule.recurse=false`; HTTPS uses the IP resolved and checked at fetch time via
   `-c http.curloptResolve=<host>:443:<ip>`; SSH connects to the checked IP with `HostKeyAlias=<host>`. Git runs under
   `env -i` with a fixed `PATH` (no proxy variables).
3. **SSH config ignored.** `GIT_SSH_COMMAND` is `ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o
   ProxyCommand=none -o ProxyJump=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<temp file> -i <key>`;
   non-22 ports are pinned as `[host]:port`.
4. **Symlinks.** Any symlink in the checkout whose realpath leaves the repository refuses the launch. Every bind source
   is resolved at check and at start; nested read-write binds across services are refused.
5. **Name collisions.** Before start, the resolved names of every volume, network and container are listed and any
   that already exists refuses the launch (`volumes: db: {name: othersite_db}` cannot attach another site's data).
   Compose-created volumes and networks carry `docknest.launch=<id>`; teardown removes only labelled ones.
6. **Environment cannot steer Compose.** As Safe Edit: explicit `-p <slug> -f ... --env-file <ours>`; a repository
   `.env` is never read by Compose; keys `COMPOSE_*`, `DOCKER_*`, `BUILDKIT_*` refused; CR/LF/NUL refused; a top-level
   `name:` is overridden by `-p` and shown in Check.
7. **Domain.** Lowercase LDH labels, IDNA to punycode, at most 253 characters, no wildcard; `www.` is derived, never
   typed. "Already served" uses `nginx -T` (includes followed) and treats wildcard, regex and `default_server` names as
   conflicts when they would match.
8. **Certificates in teardown.** The certificate name is journalled; teardown and Remove run `certbot delete
   --cert-name <name> --non-interactive` and `nginx -t` after any certbot edit.
9. **Git version and size.** `launch-facts` requires a git with the 2024-2025 submodule and `.gitmodules` fixes
   (minimum version set at build time) and refuses older. The 2 GB cap is enforced by watching the folder size and
   killing the process group.
10. **Deploy keys get their own table.** Deploy keys are stored in a new `deploy_keys` table in the same migration
    (`id, name, git_host, host_key_line, public_key, sealed_private_key, created_by, created_at`), shown on the
    Connections page in their own section, administrators only. This replaces "a Connection of kind Deploy key", so
    2.15 alert code never sees them. One key-file helper serves both `launch-facts` (`ls-remote`) and `launch-fetch`,
    writes outside the site folder and build context, and removes it in `finally`; the key never enters argv or
    unsealed job details. The Git host key is read from the server's network view (the helper connects and returns the
    key) and the administrator confirms its SHA-256; a re-pin action handles rotation.
11. **Jobs without a site.** Launch steps are stored like installs, in `site_launch_steps` with their own claim
    (`claimLaunch`), because `jobs.site_id` is NOT NULL.
12. **Hold and backups.** Scheduled backups of other sites on the server queue behind a launch hold instead of being
    skipped; the hold is released before `first_backup`.
13. **Certificate lineage.** certbot runs with `--cert-name docknest-<slug>`; the launch is refused when an existing
    lineage covers the domain or its `www.` alias; teardown deletes only a lineage the journal recorded as created.
14. **The buildx builder, honestly.** Its buildkitd runs as a privileged container, so a BuildKit sandbox escape is root
    on the host (no worse than dockerd's built-in builder; stated in docs). Images are built with
    `--builder <name>` and loaded into the engine so `up --no-build` finds them. The `moby/buildkit` image is pinned
    by digest in the helper.
15. **Holds seen by every claim.** `CLAIMABLE_JOB_SQL`, `claimInstall` and the restore test claim treat a running
    launch step as a hold on its server; tested.
16. **Git minimum and ports.** The minimum git is the larger of 2.37 (`http.curloptResolve`) and the CVE floor;
    the pin uses the URL's real port (`https://host:8443/` works).
17. **Pin provenance.** `deploy_keys` stores `pinned_from_server_id` (shown in the UI); using the key from another
    server asks to confirm the Git host key again from that server.
18. **Extra Linux cases:** the built image is runnable after a buildx build; a redirect to a private IP; DNS rebinding between check and fetch; a repository symlink used
    as a bind source; a volume name collision; `RUN --network=host`; a repository `.env` with `COMPOSE_FILE`; teardown
    removing the certbot lineage.

## Upgrade safety

Additive migration; the install table gains `git` (a code change, no schema change). Rolling back to 2.15.x ignores
the tables and `launch_*` jobs; a launched site is a normal site row and keeps backing up. `upgrading.md` gets "Finish
launches before rolling back". Deploy keys live in their own table, so 2.15.x never sees them.

## Test plan

- Unit/API: URL validation table (file, ext, `-` options, private IPs, IPv6 forms, userinfo), gate with no "before",
  build allow-list, slug rules, roles, re-verification, rate limits, step machine, hold predicate, migration fixture.
- Python: argv and environment of git, key file mode and removal on every path, symlink escapes after clone, journal
  before create, teardown idempotent and label-gated, nginx refusal on an existing domain.
- Browser: New site from the server "+", both sources, checks with install offers, trust warning, timeline, waiting DNS,
  failure panel, phone and both themes.
- Linux integration (`scripts/integration-launch.js`, local Git daemon and a local ACME test server where possible):
  1. Pasted Compose (nginx image) with a domain on `/etc/hosts`: deploy, nginx, HTTP check, site saved, first backup verified.
  2. Public HTTPS repo with `build:`: builds, runs, backed up.
  3. Private repo over SSH with a deploy key and a pinned host key; wrong host key refused; key file absent after.
  4. Compose adding `privileged`, `docker.sock`, `network_mode: host`, a `/etc` bind, `build.network: host`: refused at check.
  5. Health check that never passes: teardown, no container, image, network, folder, nginx file or key left.
  6. Kill the worker during build: teardown on restart.
  7. Domain already served by nginx: refused.
  8. Certificate with Pebble (ACME test server) where available; otherwise asserted up to the certbot call.

## Real and unusual use cases

- A WordPress + MariaDB Compose file pasted from the image's docs, with passwords typed as environment values.
- A Node app in a private GitHub repository with a Dockerfile; the owner adds the deploy key read-only.
- A self-hosted Gitea on the LAN (private address): needs "Allow private address".
- A Compose file that publishes `80:80` itself: rewritten by the override to the loopback port, explained in Check.
- A repository whose Compose file is in `deploy/compose.yaml` with a `.env.example`: the environment form starts
  from the example's keys, values empty.
- A tag instead of a branch (`v1.4.2`); a monorepo with the app in a subfolder (`context: ./apps/web`).
- DNS on Cloudflare (record created) vs. another registrar (record shown, **Check again**).
- A server without nginx and certbot: two install offers before Launch.
- A server with only one connected server in DockNest: restore tests stay off with the reason.
- An ARM server and an image without an ARM build: fails at start with "This image has no build for arm64".

## Owner questions

1. **Builds on the server.** Allow Compose files with `build:` (code from the repository runs at build time on the
   server), or only prebuilt images in 2.16? Recommendation: allow, with the build allow-list, the trust warning and
   re-verification; most private apps need it.
2. **Git on the server.** Install `git` on the server (through the existing install offer) or fetch on the DockNest
   host and copy the files over SFTP? Recommendation: on the server; it keeps the deploy key off the dashboard's disk
   and needs no Git in the DockNest image.
3. **Undo window.** Offer **Remove launch** for 24 hours after launch? Recommendation: yes, it makes trying a site cheap
   and never touches anything the launch did not create.

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the flow and journals,
[DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md)
for Git, build and nginx steps,
[Security Architect](https://github.com/msitarzewski/agency-agents/blob/main/security/security-architect.md) and
[Secrets and Credential Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-secrets-credential-engineer.md)
for the threat model and deploy keys, and
[UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md) for the boards.
