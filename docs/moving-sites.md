# Moving a site to another server

Administrators move sites from the Map page (operators see the map read-only). Real moves count as validated
only when the two-host Linux Docker integration test (`scripts/integration-move.js`, CI job `linux-integration`)
passes (see AGENTS.md).

## If a server is missing a tool

When a check says a server needs nginx, Docker, Compose or Certbot and DockNest can install it, the **Ready to move** sheet offers **Install nginx** (or the tool's name) and **Show command**. Install asks you to confirm it is you (the same check as a move), shows each step, and **Check again** re-runs the check. **Show command** shows the exact command so you can run it yourself. All these sheets are the same size with their buttons in the same place. The server's details panel on the Map lists the same tools.

## The short version

1. On the Map page, drag the end of a site's line off its server and drop it on another server (with the keyboard: focus the site, press Enter, **Move to…**; on a phone: **Details**, then **Move to…**, or **Move to…** in the list). While a site is not connected, **Save changes** stays off ("Connect every site to a server to save"); **Cancel** puts the line back.
2. Press **Save changes**. DockNest checks both servers and shows **Ready to move** with how long the move takes,
   how long the site is offline and how long you can undo, or the one reason it cannot move yet.
   **Advanced settings** holds the details; most people never need them.
3. Press **Move**. DockNest copies the site, tests the copy, switches over and tells you when it is done.
   You can press **Cancel** until the switch.

Your site stays online on the old server while the copy is made and tested. It goes offline only for the final
copy, behind a maintenance page.

## What happens during a move

| Step | What DockNest does | What you see |
|---|---|---|
| Check | Checks disk space, ports, Docker, Compose, processor type, nginx, folders and DNS on both servers. | The ready sentence, or the reason it cannot move. |
| Backup | Takes a fresh verified backup. A move never deletes a backup. | "Backing up" |
| Copy and test | Restores the copy on the new server, reachable only from that server, and tests it. | "Testing the copy" |
| Wait for you (manual DNS only) | Waits until you press **Switch now**, so you choose when the short downtime happens. | "Ready to switch" |
| Final copy | Shows the maintenance page on the old server, stops the old site, takes a final backup and starts it on the new server. | "Final copy" |
| Switch | Changes the DNS record for you (Cloudflare) or shows you the exact record to change. | The DNS record, with a copy button |
| Done | Confirms the domain points at the new server, sets up the certificate if a certificate tool is installed. | "Done" |

The old copy is kept, stopped, for 7 days, so you can **Switch back**. After 7 days DockNest asks whether to remove
it. It never deletes your data by itself.

## Cancel and switch back

- **Cancel** is offered until the switch starts. Cancelling undoes everything the move created on the new server and,
  if the old site was already stopped, starts it again.
- After the switch, **Cancel** is replaced by **Switch back** (within the 7 days). Switching back shows the
  maintenance page on the new server, stops the new copy (kept, with restart off), starts the old copy with its
  original restart settings, points DNS back (automatically with Cloudflare, otherwise DockNest shows the record to
  change) and moves the site record back. Data written on the new server after the switch is not copied back.
- After 7 days DockNest asks **Remove old copy?**. It never removes anything by itself. Removing deletes the stopped
  old containers; their data folders and volumes stay unless you tick **Also delete the old data** (data still used by
  another container is always kept). You type the site name to confirm.
- If a step takes much longer than it should, DockNest stops it on the server, confirms it stopped, and shows **Try
  again** (and **Undo** before the switch). Until the server confirms, nothing else runs for that move.
- Once the DNS switch has started, DockNest never undoes the move by itself: visitors may already be writing to the
  new copy. If a later step fails (certificate, finish, a lost connection), the move shows the reason with **Try
  again** or **Switch back**, and keeps the new copy and its data. If finishing fails because the old server is gone,
  **Finish without the old server** (type the site name) completes the move without stopping the old copy; the move
  then warns that the old copy may start again and offers **Disable old copy** for when that server is back.
- While DockNest waits for DNS, **Cancel and go back** (the same Switch back action) stops the new copy and starts the
  old site again. After 48 hours of waiting the move asks you to check the record. When the domain is behind
  Cloudflare's proxy (orange cloud), public DNS never shows your server; DockNest says so and lets you confirm the
  change yourself (**I changed it**).
- Before rolling DockNest back to a release without moves (2.5.0 or older), finish or cancel every move. Older
  releases ignore move jobs (they use their own job statuses), but they cannot continue or undo a move.

## When a move is refused

DockNest refuses a move rather than risk breaking a site. It tells you the reason in one sentence, for example:

- "Not enough space on new-srv: needs about 7 GB, has 5 GB free."
- "new-srv needs nginx. Install it, then try again."
- "new-srv already has a folder /srv/shop/data. DockNest never overwrites folders."

Fix the reason, then press **Save changes** again to re-check.

## Installing missing software on the new server (optional)

When a move is blocked because the new server has no nginx, Docker, Docker Compose 2 or certbot, DockNest can install
it for you. This is always optional and always asked: an administrator presses **Install**, confirms, and signs in
again (re-verification within 5 minutes). Next to it, **Show command** displays the exact line you could run yourself.

- Supported only on Debian and Ubuntu (apt) and on Fedora, Rocky Linux, AlmaLinux and RHEL (dnf), and only with the
  server's own distribution packages. DockNest never adds a package source, never downloads a script, never edits a
  configuration file and never removes anything.
- On other systems, and for software the system's own sources do not offer, the plain note stays and "Show command"
  shows the best known line (or none).
- If the server is busy with a backup, restore or move, or the software is already there, nothing is installed.
- Before offering Docker, DockNest reads the version the system's own sources offer. When a site has several
  containers and the offered Docker is older than 28, or its version cannot be read (2.12.1), `supported` is false and
  the check carries `install.reason`: "This server's packages offer Docker 26.1; this site needs 28 or newer. Install
  Docker from Docker's own repository instead." `command` is then a comment line pointing to Docker's official
  instructions (https://docs.docker.com/engine/install/); DockNest never runs a downloaded script.
- DockNest never installs over software from another source: if the binary exists, or the package manager lists any
  matching package (for example `docker-ce` or `containerd.io`), the answer is 409 `ALREADY_INSTALLED`. For Docker
  that reads "Docker is installed but not running. Start it, then check again." apt runs with `--no-remove`, so it
  can never remove a conflicting package.
- An install and a move never overlap on a server: starting a move answers 409 `INSTALL_RUNNING` while an install
  is queued or running on its source or target server, and a queued install waits while a move touches the server.

| Software | apt (Debian, Ubuntu) | dnf (Fedora) | dnf (Rocky, AlmaLinux, RHEL) |
| --- | --- | --- | --- |
| nginx | `nginx` | `nginx` | `nginx` |
| Docker | `docker.io` | `moby-engine` | not offered |
| Docker Compose 2 | `docker-compose-v2` (Ubuntu 22.04 and newer only) | not offered | not offered |
| certbot | `certbot python3-certbot-nginx` | `certbot python3-certbot-nginx` | not offered (needs EPEL) |

### Preflight field

Each check for these four tools that blocks a move (and the certificate note for certbot) carries
`install: { package: "nginx"|"docker"|"compose"|"certbot", command: string, supported: boolean }`.
`command` is the line a person would run (or a comment with Docker's documentation link), and `reason` (optional) says in
one sentence why `supported` is false for this site. For example
`sudo apt-get update && sudo apt-get install -y --no-install-recommends nginx`; it is empty when no distribution
package line is known. `supported` is true only for the combinations in the table. The field is absent when the
tool is present (including an old Docker Compose) or when the server's system could not be read.

### POST /api/servers/:id/install

Body `{ "package": "nginx" | "docker" | "compose" | "certbot", "siteId"?: "<uuid>" }` and nothing else (any other
field, including a command, answers 400). A move's install sends the site; its selected containers then decide the
Docker need exactly as in preflight (several containers need 28), and a missing site answers 404. The server panel
sends no site. Administrators only, CSRF token like every API write, and a re-verification within 5 minutes
(403 `REAUTH_REQUIRED`). DockNest re-reads the server first and answers 409 with a plain `error` and one of these
`code` values: `SERVER_BUSY` (a job, a move or another install uses the server), `SERVER_UNREACHABLE`,
`INSTALL_UNSUPPORTED`, `ALREADY_INSTALLED`. Success is `202 { "job": { "id": "..." } }`; the request is audited as
`server.install.requested`.

Poll `GET /api/jobs/:id` (same shape as other jobs): `type: "install"`, `status` `queued|running|completed|failed`,
`error` (one fixed sentence chosen from the helper's short failure code; unknown codes give a generic sentence; never command output or exception text), and
`details: { serverId, package, steps: [{ name, status }] }` with the four steps `Connected`, `Package list updated`,
`Installing <name>`, `Checking <name> works`, each `queued|running|done|failed`. Install runs are stored in their own
table (`server_installs`, schema v7) because a job normally belongs to a site; they do not appear in the site job
history. The worker runs an install only when no site job is running on that server. If DockNest stops during an
install the run is marked failed ("DockNest stopped while installing"); the package tool on the server finishes on
its own, so check the server, then save the move again to re-check.


## Advanced settings

Collapsed by default and pre-filled; most moves need no changes here.

- **Ports**: if a port is taken on the new server, the site listens on the next free port instead. The site's own
  settings stay the same; only the nginx route on the new server changes.
- **nginx**: DockNest writes one file of its own on the new server. Custom settings from the old server's nginx block
  are listed here because they are not copied.
- **Settings that name the old server**: values in `.env` files or container settings that point at the old server
  are listed (with passwords removed). Rewriting a value is off by default and only changes the new copy.
- **Downtime estimate**: how the estimate was calculated (last backup and restore times). If the final copy would
  keep the site offline for more than 30 minutes, the check turns amber and the move starts only after you press
  **Move anyway**.
- **Ask before switching** (off by default): the move pauses after the test so you choose when the downtime starts.
- **Test copy**: the copy runs your real app on a copy of your data, reachable only from the new server. Outgoing
  mail (ports 25, 465, 587) from the copy is rejected by rules DockNest adds to Docker's `DOCKER-USER` firewall
  chain (`iptables`, and `ip6tables` for IPv6 networks) for the networks of the copy only, before any copy container
  starts; the copy never joins Docker's shared default bridge. The rules are removed with the copy. Where that chain does not exist (Docker with
  `iptables: false`, rootless Docker, nftables-only hosts) the preview says so plainly and the copy could send email.
  Mail through an HTTP API (for example a mail service's REST API) is not blocked, and scheduled jobs and webhooks
  may run once. DockNest does not put the copy on a network without internet, because many apps fail to start
  without their external services, which would make the test meaningless.
- **DNS**: "I'll change DNS myself" (default) shows the record and waits until public DNS points at the new server.
  "Switch the domain for me" needs a Cloudflare API token (Settings): DockNest changes the A record (and an AAAA
  record when the new server has IPv6) after the copy passed its test, and changes it back on Undo or Switch back.
- **Certificate**: with a certbot account already on the new server, DockNest issues the certificate. Otherwise the
  move still finishes and shows the one command to run there (DockNest never installs certbot).

## How the engine keeps track (for contributors)

- Each move is a row in `site_moves`; each step has a journal row in `site_move_steps` (migration 6, additive).
  One unfinished move per site is enforced by a partial unique index.
- `src/moves/state.js` is the pure state machine: states, allowed transitions, step plan, journal records, cancel
  rules, rollback order and crash recovery. A step is journaled as running before its effect and as done after it;
  after a crash a running step is checked against the real servers and is either marked done, undone and re-run, or
  the move stops in `recovery_required` with a plain explanation. It is never silently forgotten.
- `src/moves/preflight.js` turns facts collected from both servers into checks, one verdict sentence and the
  Advanced details. The facts come from the read-only helper operation `move-facts` on both servers.
- Journal rows and stored preflight results never contain secret values. The journal refuses secret-looking data.
- `src/moves/engine.js` persists and drives moves. `tickMoves()` runs in every worker loop: steps that only touch
  the database (backup, final copy, the manual switch) run inline and wait for their backup job without holding a
  job; every step that touches a server runs as one short `site-move` job, and `claimJob` keeps both servers busy
  while it runs. A worker restart fails the interrupted `site-move` job and the move resumes from its journal: an
  unfinished deploy is checked with `deploy-status`, undone with `deploy-teardown` and run again.
- Helper operations (`remote/helper/move.py`): `move-facts` (read-only; env keys with masked values only),
  `deploy-restore` (test or live; journals every folder, volume, network, container, image, firewall rule and nginx
  file on the target before creating it; refuses anything that already exists), `deploy-teardown` (removes only what
  the journal lists and the `docknest.move=<id>` label confirms; refused once the move finished), `deploy-status`,
  `move-test`, `move-resume-source`, `move-retire-source`, `move-finalize-target`, `move-certificate`. Isolated restore
  shares its verify-and-unpack code and is pinned by a golden test (`remote/test_moves.py`).
- Compose sites (one project whose files are selected in the site) deploy with the site's own Compose files plus a
  generated override (`/var/lib/docknest/moves/<move>/compose.<test|live>.yaml`: snapshot image, `ports: !override`
  with the remapped host ports, restart `no` for the test copy, DockNest labels). The user's files are never edited.
  This needs Compose 2.24 or newer on the new server; otherwise, and for single containers, containers are recreated
  from their snapshot images with `docker create`, which copies ports, mounts, networks, extra hosts and `--init` but
  not resource limits or log drivers. After a move, running `docker compose up` by hand without the override brings
  the original host port back.
- Paths: a move refuses to create anything under system folders (`/etc`, `/root`, `/usr`, `/boot`, `/bin`, `/sbin`,
  `/lib*`, `/proc`, `/sys`, `/dev`, `/run`, `/var/log`, `/var/spool`), Docker's storage, `.ssh` folders or protected
  files, with symlinks followed; only its own folders below `/var/lib/docknest` (moves, acme, maintenance) are allowed.
  Since 2.11.1, a path the backup names (data folders, configuration files, a static site) must also lie below an
  application location:
  - any non-standard, non-hidden top-level folder (`/opt`, `/srv`, `/mnt`, `/media`, `/data` ...);
  - `/var/www` or `/var/opt`;
  - `/var/lib/<app>`, except folders owned by the operating system, package managers, init, container runtimes or
    cloud-init (for example `cloud`, `docker`, `containerd`, `dpkg`, `apt`, `systemd`, `polkit-1`, `sudo`, `snapd`,
    `ucf`, `pam`, `NetworkManager`, `dhcp`, `lxcfs`, `private`);
  - a non-hidden folder inside a home folder other than `~/bin` (`/home/<user>/<folder>`; also `/var/home`,
    `/var/srv` and friends on image-based systems).

  The path must not pass through a symbolic link on the new server. The one exception is image-based systems
  (Fedora CoreOS, Silverblue, IoT): a root-owned top-level `/home`, `/srv`, `/opt` or `/mnt` link whose target is
  `var/<name>` is accepted when `/var` and `/var/<name>` are not links themselves. Any other link on the way is
  refused. Below `/var/lib`, an application folder that holds an entry this move did not create is never written into. Anything else, such as `/tmp`, `/efi`,
  `/nix`, `~/.config` or `~/bin`, is refused, and the site is moved by hand.

  A bind mount of password files, sudo rules or SSH or GPG keys is not copied by backups, so a move refuses a site that
  has one. `.ssh` and `.gnupg` folders inside a copied bind mount are left out of backups (2.12.1), so the moved copy
  has none; the backup's warning names them. Restored files never keep setuid or setgid bits (2.12.1). A backup that
  names the host network or another container's network, or a relative or `..` configuration path, is refused. Other
  spellings (`//`, `./`, a trailing `/`) are normalised first. Settings are rewritten only in files the move placed.
  An image archive that names any image tag is refused before `docker load`, because DockNest backups save images by
  ID.
  The maintenance folder on the new server is always DockNest's own `/var/lib/docknest/maintenance/<site>`, never an
  existing web root; the move journals it when it creates it and removes it on Undo. The site record follows at the
  finish and goes back on Switch back.
- Compose: the merged configuration (`docker compose config`) is checked against allow-lists of known top-level and
  service settings; anything else (for example `security_opt`, `sysctls`, `volumes_from`, `uts`, `cgroup`,
  `cgroup_parent`, privileged mode, host namespaces, devices, added capabilities, secrets or configs read from files,
  volumes with driver options, external networks or volumes, networks or mounts the backup does not hold, fixed
  addresses) is refused with the reason. A Compose project of the same name already on the new server is refused.
- Remove old copy with data deletes only read-write data folders and volumes of the old containers; never folders used
  by another container, served by nginx on that server or named in another DockNest site's settings (compared after
  following symlinks), never a home folder itself (`/home/<user>` or any user's home), and never system paths. What was kept is listed in the step result (`kept`).
- Move jobs use the statuses `move_queued` and `move_running`, so a release without moves never claims them.
- Step time limits come from `src/moves/state.js` (for example 60 minutes for a deploy, 5 for the test). A backup step
  past its limit fails and the move undoes itself; a server step past its limit sets `needs_attention` because its
  outcome is unknown, and the owner chooses Try again or Undo (`POST /api/moves/:id/resolve`).
- Only bridge networks move. After Switch back the stopped new copy stays on the new server; remove it by hand
  (`docker rm` of the containers labelled `docknest.move=<move id>`) before moving the site there again.
- Cloudflare (`src/moves/cloudflare.js`): the token is checked with read calls only (token verify, zone list, a DNS
  record read per zone), sealed with the master key, stored in settings, decrypted only for a call, and never
  returned, logged, audited or journaled. All calls go to `https://api.cloudflare.com` without redirects. Edit
  permission cannot be proven without writing, so a token without Zone.DNS:Edit fails at the switch; the move then
  needs attention. `switched_at` is set together with the journal, before the first change, so Undo is refused once a
  record may have changed.

## API for the UI (administrators only)

All routes need an administrator session and the usual CSRF header. Errors are `{ "error": "<one plain sentence>" }`
with an HTTP status, plus `code` where the UI must react (`REAUTH_REQUIRED`, `MOVE_ANYWAY_REQUIRED`,
`PREFLIGHT_CHANGED`, `SITE_MOVING`). Operators receive 403.

### POST /api/moves: preview ("Save changes")

Request: `{ "siteId": uuid, "targetServerId": uuid, "options"?: { "dnsMode": "manual", "envRewrite": ["KEY"], "askBeforeSwitch": false } }`.
`dnsMode: "cloudflare"` answers 400 until a Cloudflare token is saved, and when the token's zones do not cover the
domain. Response 201:

```json
{
  "id": "uuid of the draft move (null when the site is already on that server)",
  "siteId": "uuid", "targetServerId": "uuid",
  "ok": true,
  "mailBlocked": true,
  "verdict": "ready | ready-with-notes | blocked",
  "sentence": "Shop is ready to move to new-srv. It stays online while the copy is tested; expected downtime is about 40 seconds, then until your DNS change is live.",
  "needsMoveAnyway": false,
  "estimateSeconds": 190,
  "downtimeSeconds": 40,
  "downtimeText": "about 40 seconds, then until your DNS change is live",
  "undoDays": 7,
  "preflightHash": "64 hex characters; send it back to start",
  "blockers": ["one sentence per refusal"],
  "warnings": [{ "id": "port", "text": "Port 8082 is already used on new-srv. ...", "advanced": false, "requiresConfirmation": false }],
  "advanced": {
    "ports": [{ "from": 8082, "to": 8083, "containerPort": 80, "protocol": "tcp", "hostIp": "127.0.0.1", "changed": true }],
    "nginx": { "file": "/etc/nginx/conf.d/docknest-<siteId>.conf", "notCopied": ["client_max_body_size"] },
    "envKeys": [{ "key": "API_URL", "where": "container web", "kind": "host | ip", "masked": "http://203.0.113.7:9000", "rewrite": false }],
    "dns": { "mode": "manual", "record": { "type": "A", "name": "shop.example.com", "value": "198.51.100.9" }, "cloudflareAvailable": false },
    "deployMethod": "compose-override | docker-create | files",
    "tests": { "http": { "host": "shop.example.com", "path": "/" }, "mailBlocking": { "blocked": true, "method": "firewall | none", "text": "one plain sentence" }, "note": "..." },
    "checks": [{ "id": "disk", "status": "ok | info | warn | block", "title": "Disk space", "text": "..." }]
  }
}
```

A preview is stored as a draft move. It blocks no other work, a newer preview for the same site replaces it, and it
expires after an hour. `downtimeSeconds` and `estimateSeconds` are `null` until the site has a timed backup. To
change Advanced settings (for example `envRewrite`), post a new preview. `needsMoveAnyway` is decided by the server
(an estimated final copy over 30 minutes, the owner's rule); the UI shows the amber warning and sends
`moveAnyway: true` only after the owner presses **Move anyway**.

### POST /api/moves/:id/start ("Move")

Needs a re-verification within the last 5 minutes (403 `REAUTH_REQUIRED` otherwise). Request:
`{ "preflightHash": "<from the preview>", "moveAnyway"?: true }`. The server re-runs every check; if anything changed
it answers 409 `PREFLIGHT_CHANGED` with the fresh preview in `preview`. Long downtime without `moveAnyway` answers
409 `MOVE_ANYWAY_REQUIRED`. Success: 202 with the move (same shape as GET).

### GET /api/moves/:id (poll every few seconds)

```json
{
  "id": "uuid", "siteId": "uuid", "siteName": "Shop", "sourceServerId": "uuid", "sourceName": "old-srv", "targetServerId": "uuid", "targetName": "new-srv",
  "state": "draft | queued | running | waiting_switch | waiting_dns | cancelling | rolling_back | needs_attention | done | switching_back | switched_back | cleaned | rolled_back | cancelled | failed",
  "dnsMode": "manual | cloudflare", "mailBlocked": true,
  "actions": { "cancel": true, "switchBack": false, "dnsProxied": false, "disableOldCopy": false, "removeOldCopy": false, "askRemoveOldCopy": false, "resolve": ["retry", "undo", "finish-without-old-server"] },
  "engineState": "the state.js state, for diagnostics",
  "waitingFor": "owner-switch | dns | null",
  "statusLine": "One plain sentence for the progress screen.",
  "progress": 45,
  "cancelable": true, "cancelLabel": "Cancel | Cancelling...",
  "dns": { "type": "A", "name": "shop.example.com", "value": "198.51.100.9" },
  "downtimeText": "about 40 seconds, then until your DNS change is live",
  "error": null,
  "steps": [{ "step": "deploy_test", "label": "Copy to the new server", "state": "pending | running | done | failed | skipped | undone | undo_failed", "startedAt": null, "finishedAt": null, "result": {} }],
  "createdAt": "ISO", "updatedAt": "ISO", "switchedAt": null, "retainUntil": null, "finishedAt": null
}
```

`progress` is a whole percentage of finished steps. `dns` is the record to show with a copy button (null for a site
without a domain). In `waiting_dns` DockNest checks public DNS every 15 seconds (every minute after five minutes)
and finishes by itself. `done` covers the 7 days the old copy is kept; `retainUntil` says until when.

### GET /api/moves

`{ "moves": [ ...same shape as GET /api/moves/:id ] }`: every started move that is not finished, plus completed moves
still keeping their old copy. Drafts are not listed.

### POST /api/moves/:id/cancel

No body; needs a recent re-verification. Allowed until the switch starts (`cancelable`). A draft or a queued move ends at once (`cancelled`);
otherwise the move undoes what it created (`cancelling`) and ends `cancelled`. After the switch: 409 with the reason.

### POST /api/moves/:id/continue

Needs a recent re-verification. `{ "gate": "owner-switch" }` is **Switch now** when Ask before switching is on;
`{ "gate": "dns" }` is **Check DNS now** and answers 409 with the reason while DNS still points elsewhere. When the
domain is behind Cloudflare's proxy the 409 has `code: "DNS_PROXIED"` and `actions.dnsProxied` is true; the owner then
confirms with `{ "gate": "dns", "confirmed": true }` (**I changed it**).

### POST /api/moves/:id/switch-back

No body; needs a recent re-verification. Allowed while `actions.switchBack` is true: a finished move whose old copy
was not removed, a move waiting for DNS (**Cancel and go back**), or a move that needs attention after the switch. 202 with the move (`switching_back`, then `switched_back`). With manual DNS, `dns` then holds the
record pointing back at the old server.

### POST /api/moves/:id/disable-old-copy

No body; needs a recent re-verification. Allowed while `actions.disableOldCopy` is true (a move finished without the
old server): stops the old copy and turns its restart off. 202 with the move.

### POST /api/moves/:id/remove-old-copy

`{ "confirmation": "<site name>", "deleteData": false }`; needs a recent re-verification. Allowed while
`actions.removeOldCopy` is true; `actions.askRemoveOldCopy` turns true after the 7 days, when the UI asks
**Remove old copy?**. 202 with the move; it ends `cleaned`. A wrong name answers 409.

### POST /api/moves/:id/resolve

`{ "action": "retry" | "undo" | "finish-without-old-server", "confirmation"?: "<site name>" }` for a move in
`needs_attention`; needs a recent re-verification. `actions.resolve` lists what is allowed (no Undo after the switch;
`finish-without-old-server` only when finishing failed, with the site name). Answers 409 while a step of the move is
still running on a server.

### Step results the UI shows

`steps[].result` may hold `error`, `status`, `skipped`, `mailBlocked`, `ports`, `http`, `record`, `lastCheck` and
`lastCheckAt` (DNS wait), and for the certificate step `reason` (`no-certbot`, `no-account`, `certbot-failed`) with
`command`: the exact line to run on the new server.

### Cloudflare token: GET/PUT/DELETE /api/settings/cloudflare-dns

Administrators only; PUT and DELETE need a recent re-verification. GET answers
`{ "configured": true, "zones": ["example.com"], "savedAt": "ISO" }` and never the token. PUT `{ "token": "..." }`
checks the token with read calls and answers the same shape, or 400 with Cloudflare's reason. DELETE removes it.
