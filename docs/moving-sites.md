# Moving a site to another server (draft)

Status: the move engine and its API exist; the Map page that uses them is being built. Real moves count as validated
only when the two-host Linux Docker integration test (`scripts/integration-move.js`, CI job `linux-integration`)
passes (see AGENTS.md).

## The short version

1. On the Map page, drag the line from a site to another server.
2. Press **Save changes**. DockNest checks both servers and shows one sentence: either the site is ready to move
   (with the expected downtime), or the one reason it cannot move yet.
3. Press **Start move**. DockNest copies the site, tests the copy, switches over and tells you when it is done.

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
- After the switch, **Cancel** is replaced by **Switch back** (within the 7 days).

## When a move is refused

DockNest refuses a move rather than risk breaking a site. It tells you the reason in one sentence, for example:

- "Needs about 7 GB. new-srv has 5 GB free."
- "nginx is not installed on new-srv. DockNest does not install software; install it, then check again."
- "/srv/shop/data already exists on new-srv. DockNest never overwrites existing folders."

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
  mail (ports 25, 465, 587) from the copy is blocked when the new server's firewall (iptables `DOCKER-USER`) allows
  it; scheduled jobs and webhooks may still run once.

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
- Limits of this version: containers are recreated from their snapshot images (`docker create`), so resource limits,
  log drivers and other host settings beyond ports, mounts, networks, extra hosts and `--init` are not copied; Compose
  project files are copied to the same paths. Only bridge networks move. The old copy is kept for 7 days; Switch back
  and Remove old copy come in a later release. Cloudflare switching is a stub (`src/moves/dns.js`).

## API for the UI (administrators only)

All routes need an administrator session and the usual CSRF header. Errors are `{ "error": "<one plain sentence>" }`
with an HTTP status, plus `code` where the UI must react (`REAUTH_REQUIRED`, `MOVE_ANYWAY_REQUIRED`,
`PREFLIGHT_CHANGED`, `SITE_MOVING`). Operators receive 403.

### POST /api/moves: preview ("Save changes")

Request: `{ "siteId": uuid, "targetServerId": uuid, "options"?: { "dnsMode": "manual", "envRewrite": ["KEY"], "askBeforeSwitch": false } }`.
`dnsMode: "cloudflare"` answers 400 until automatic switching ships. Response 201:

```json
{
  "id": "uuid of the draft move (null when the site is already on that server)",
  "siteId": "uuid", "targetServerId": "uuid",
  "ok": true,
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
    "tests": { "http": { "host": "shop.example.com", "path": "/" }, "mailBlocking": "where the server firewall allows it", "note": "..." },
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
  "state": "draft | queued | running | waiting_switch | waiting_dns | cancelling | rolling_back | needs_attention | done | rolled_back | cancelled | failed",
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

No body. Allowed until the switch starts (`cancelable`). A draft or a queued move ends at once (`cancelled`);
otherwise the move undoes what it created (`cancelling`) and ends `cancelled`. After the switch: 409 with the reason.

### POST /api/moves/:id/continue

`{ "gate": "owner-switch" }` is **Switch now** when Ask before switching is on; `{ "gate": "dns" }` is **Check DNS
now** and answers 409 with the reason while DNS still points elsewhere.
