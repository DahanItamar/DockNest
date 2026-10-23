# Moving a site to another server

Administrators move sites from the Map page (operators see the map read-only). Real moves count as validated
only when the two-host Linux Docker integration test (`scripts/integration-move.js`, CI job `linux-integration`)
passes (see AGENTS.md).

## The short version

1. On the Map page, drag a site onto another server (on a phone: **Move to…**).
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
- Helper operations (`remote/helper.py`): `move-facts` (read-only; env keys with masked values only),
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
