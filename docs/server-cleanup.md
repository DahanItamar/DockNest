# Server cleanup

Docker leaves things behind: containers that stopped long ago, images that lost their tag after an update, volumes no
container uses and build cache. Server cleanup shows how much space they take on one server and removes them after you
confirm. It never removes anything DockNest or one of your sites still needs.

Administrators only. Open **Storage**, scroll to **Server cleanup**, pick a server and press **Scan**.

## What a scan shows

| Group | What can go |
| --- | --- |
| Stopped containers | Exited, created or dead containers that nothing below protects |
| Dangling images | Images without a tag that no container uses |
| Unused volumes | Anonymous volumes (64-character names) that no container mounts |
| Build cache | Build cache no build is using, older than one day (shown as "up to": Docker's figure is an upper bound) |

Each group lists its items with their size. Untick a group to leave it out. **Kept items** lists what DockNest found but
will not remove, with the reason.

**Clean up** asks once more, then removes the items you saw. The result says how much space was freed and why any item
was skipped. Every clean is written to the Audit log: who ran it, on which server, what was removed, how many bytes,
and the outcome (also when it was refused).

## What is never removed

- Containers, images and volumes a registered site uses, including archived sites, other services of the same Compose
  project, and named volumes that the site's recent backups list even if their container is gone.
- Anonymous volumes of a site's Compose project (from the site's recent backups), even when every container of that
  stack is gone after `docker compose down`.
- Anything of a backup in progress (its snapshot images), of a restore or restore test (its copies and their images and
  volumes), and of a site move (its copies, and the stopped old copy kept on the old server after a move).
- DockNest itself: its containers, images (also old builds), volumes and staging folders.
- Containers in a Compose project that still has a running container.
- Named volumes of unknown owner. DockNest cannot tell whether a stack that is down will use them again, so it keeps
  them. Remove those yourself if you are sure.
- Anything less than an hour old.

When it is unclear who owns something, it stays.

## Safety rules

- No blanket prune. Every container, image and volume is removed on its own, by ID, without force. Docker itself still
  refuses to remove anything in use.
- The preview is checked again at clean time. The server is read again, and each item is checked once more right before
  it is removed. An item that changed, came into use or became protected since the scan is skipped.
- A clean stops starting new removals after 30 minutes; anything left is listed as not removed (Time limit reached).
  Scan again to continue.
- A preview is valid for 15 minutes and can be used once, by the administrator who made it. Scan again after that.
- Cleanup waits while a backup, restore, restore test, site move, Safe Edit or self-heal restart uses the server, and
  only one cleanup runs per server. An unfinished Safe Edit holds its server between its steps too (for example while
  it waits for the site to become healthy).
  On the server it also refuses while any backup job folder is unfinished or any restore staging folder exists, however
  old: a folder an interrupted job left behind blocks cleanup until DockNest's recovery finishes it.
- Nothing starts while a clean runs. DockNest puts a hold on the server for the length of the clean: backups, restores,
  restore tests, move steps, Safe Edit steps, self-heal restarts and installs queued meanwhile wait and start right
  after it, they never fail. A hold left by a crash expires after 45 minutes. On the server, every backup, restore,
  restore test and move step, and Safe Edit's prepare, apply and rollback and the self-heal restart, share a lock that
  the clean takes exclusively, so the two can never overlap even if the hold were missed. A Safe Edit step that meets a
  running clean answers "busy" and is tried again (a rollback is never left stuck); a self-heal restart is recorded as
  "A server cleanup was running" and tried again after its 60 seconds.
- The clean stops when DockNest stops waiting for it: DockNest keeps the SSH session's input open for the whole clean,
  and a dropped connection or a stopped DockNest ends the clean on the server.
- Build cache is the one group cleaned as a whole: DockNest runs `docker builder prune --filter until=24h` without
  `--all`, so BuildKit removes only cache no build references. Build cache never holds site data; the next build may be
  slower.

Sizes are what Docker reports. Images can share layers, so the space actually freed by images can be smaller than the
sum shown. A volume too large to count quickly shows Unknown, and so does any volume left when the scan's one-minute
sizing budget runs out.
