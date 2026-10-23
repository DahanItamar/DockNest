# Moving a site to another server (draft)

Status: draft. The move engine is being built and is not available in the app yet. Nothing in this document is
validated until the two-server Linux Docker integration tests pass (see AGENTS.md).

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
- **Downtime estimate**: how the estimate was calculated (last backup and restore times).

## How the engine keeps track (for contributors)

- Each move is a row in `site_moves`; each step has a journal row in `site_move_steps` (migration 6, additive).
  One unfinished move per site is enforced by a partial unique index.
- `src/moves/state.js` is the pure state machine: states, allowed transitions, step plan, journal records, cancel
  rules, rollback order and crash recovery. A step is journaled as running before its effect and as done after it;
  after a crash a running step is checked against the real servers and is either marked done, undone and re-run, or
  the move stops in `recovery_required` with a plain explanation. It is never silently forgotten.
- `src/moves/preflight.js` turns facts collected from both servers into checks, one verdict sentence and the
  Advanced details. Fact collection over SSH is added in a later change.
- Journal rows and stored preflight results never contain secret values. The journal refuses secret-looking data.
