# Self-heal for unhealthy containers

Docker restarts a container that exits, if its restart policy says so. It does nothing for a container that keeps
running but fails its health check. Self-heal fills that gap: when Docker marks a container of a site unhealthy,
DockNest restarts it, a limited number of times, and tells you through your alert Connections.

It is off for every site until an administrator turns it on. The design is in [self-heal.md](self-heal.md).

> **Works while DockNest is running.** DockNest watches the server over its own SSH connection. While DockNest (or
> its worker) is stopped, the laptop it runs on sleeps, or the server is unreachable, nothing is healed. Docker's own
> restart policy still restarts containers that exit.

Not validated yet: this release adds self-heal with unit tests and a Linux Docker integration test
(`scripts/integration-self-heal.js`). Until that test passes in CI on Linux, treat it as untested on real servers.

## What it does

1. DockNest keeps one SSH session open to each server that has a site with self-heal on, and listens to
   `docker events` for health changes of that site's containers. Nothing is installed or left running on the server.
2. When a watched container turns **unhealthy**, DockNest records it and, if the limits allow, restarts it with
   `docker restart --time 30`. DockNest's own job rules keep the restart apart from every other job of the site (see
   "When it waits"). Right before the restart the server checks once more that the container is the same one, still
   running and still unhealthy, that the site's maintenance page is off, and that no other DockNest step holds the
   site's lock file there.
3. When the container is **healthy** again, the episode is recorded as recovered.

Only containers that have a Docker health check are watched. A health check that is still in its start period
(`starting`) is never acted on.

## Turn it on

Administrators turn it on per site; operators can see the setting and the history.

- **Self-heal.** On or off. Turning it on looks up which of the site's containers have a health check. If none has,
  it stays off: "No container in this site has a health check."
- **Restarts.** How many restarts per container in one window: 1 to 10, default 3.
- **Window.** 10 minutes to 24 hours, default 1 hour.

Two restarts of the same container are always at least 60 seconds apart. If a restart fails, or the server could not
be reached, DockNest tries again after those 60 seconds; each try counts toward the limit. When a container used up
its restarts in a window, DockNest records "Restart limit reached" once and sends one **Self-heal stopped** alert.
Restarts resume by themselves as soon as the oldest restart is more than one window ago, if the container is still
unhealthy then. One server watches at most 50 containers across all its sites; turning self-heal on for a site that
would pass that is refused.

API (administrators, with the usual CSRF header): `PUT /api/sites/:id/self-heal` with
`{ "enabled": true, "maxRestarts": 3, "windowMinutes": 60 }`. `GET /api/sites/:id/self-heal` shows the settings, the
watched containers, whether DockNest is watching, and the recent history; `GET /api/self-heal/events` lists the
history of all sites.

## When it waits

Self-heal never fights DockNest's own work. No restart happens while the site:

- has a backup, restore, Safe Edit or move running, or one waiting to start;
- is being moved;
- is in maintenance;
- finished such work less than 2 minutes ago (its containers are still starting).

The unhealthy event is then recorded as skipped with the reason. When the wait is over, DockNest restarts the
container if it is still unhealthy (within about 15 seconds; at the exact moment for the 2-minute wait).

## Alerts

Two new events for site, server and DockNest lines on the Map:

- **Container restarted**: the first restart of a container in a window (every restart is in the history).
- **Self-heal stopped**: a container used up its restarts, or a watched container was recreated or removed.

Existing alert lines do not get these events automatically. Add them to a line if you want them.

## "Not watching"

The setting shows whether DockNest is watching (`connected`), trying to (`connecting`), or not (`off`), and why:

- *the DockNest worker is not running*: start it.
- *the server cannot be reached; DockNest keeps trying*: it reconnects on its own, waiting 5 seconds at first and up
  to 5 minutes between tries.
- *the server SSH host key does not match the pinned key*: DockNest stops trying. Check the server and confirm the
  new key on the server page if the change is expected.
- *Docker events could not be read on the server*: check that Docker runs and that the server's Docker is supported.
- *this server already has 50 watched containers*: turn self-heal off for another site on that server.
- *container recreated*: a watched container is gone. Turn self-heal off and on again to pick up the site's
  current containers.

## Server settings to check

The watch uses one extra SSH session per server, held open while self-heal is on for a site on that server.

- `MaxSessions` (sshd, default 10) and `MaxStartups` limit how many sessions sshd accepts. One held session per
  server is usually far below that, but count it if you limit sessions tightly.
- DockNest sends an SSH keepalive every 15 seconds and treats 3 missed answers as a lost connection.
  `ClientAliveInterval` / `ClientAliveCountMax` on the server can close idle sessions sooner; a closed session is
  simply reopened. A firewall or NAT that drops idle connections in under a minute can cause frequent reconnects.

## History

Every unhealthy event, restart, failed restart, skip, limit and recovery is kept for 90 days, then deleted by the
worker's regular maintenance. The audit log records who turned self-heal on, off or changed it, and every restart and
"gave up" (actor `self-heal`).

## Upgrading and rolling back

The update adds two tables and changes nothing else; self-heal stays off for every site. Rolling back to 2.14 ignores
the new tables and any queued restart, which then simply never runs. The upgrade script waits for running restarts
like any other job.
