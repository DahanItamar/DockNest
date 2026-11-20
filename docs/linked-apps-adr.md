# ADR: linked apps

Status: proposed for 2.16.5.

## Problem

Apps on one server often depend on each other: one database container serves several apps, two projects share an
external network or a volume, or a container links to another project's container. Since 2.16.5 one container belongs to
exactly one app (`409 CONTAINER_ALREADY_BACKED_UP`), so a shared database lives in one app and the other apps only use
it. Backing up, moving or restore-testing one of them without the other can leave a copy that does not work.

## Audit

- Discovery (`remote/helper/discovery.py`, operation `discover`) already inspects every container on the server and
  runs only when someone scans a server or adds an app. Hardening facts ride on the same scan and are stored per app.
- Nothing today records networks, links or which apps share volumes.
- The Map (`web/map/layout.js`) draws servers, apps and storage with elbow lines; databases are shown inside an app's
  details, never as nodes.
- `shared/backup-coverage.js` maps a container name to the app that backs it up.

## Decisions

1. **Facts from the existing scan.** Discovery adds, per container, only what links need: compose project, user-defined
   network names, named volumes and bind sources, `HostConfig.Links`, and the compose `depends_on` label.
   No environment values, commands or file contents. Nothing new connects to the server and nothing runs on a timer.
2. **Stored per server** in a new table `server_app_links` (migration 21, or the next free number at merge): the
   validated facts and the time of the scan. A scan replaces the row; deleting a server deletes it.
3. **Links are computed, not stored**, by a pure module `shared/app-links.js` from the facts and the current apps
   (through `coverageIndex`). Kinds, strongest first:
   - `volume`: containers of two apps mount the same named volume or bind folder.
   - `link`: a container links or depends on a container of another app.
   - `database`: two apps share a user-defined network and one side's container is a detected database.
   - `network`: two apps share a user-defined network (not `bridge`, `host`, `none`).
   One line per pair of apps, labelled with the strongest kind and the name it came through.
   A `database` link needs a database on one side and something else on the other. A network more than four apps share
   (a reverse proxy network) is a hub: it links no pair and is listed once per server. Network-only links show on the Map
   but never warn. A host folder and the folders inside it count as one; system folders never count. Links are computed
   per app, not per container pair, under a fixed work budget; running out marks the result partial.
4. **Map**: links are drawn as dashed lines between app cards in the gutter right of the app column, with the existing
   line styling and tokens. Selecting an app highlights its links; the details panel lists them. The phone list shows
   them under each app.
5. **Warnings**: Backup, Move and Restore test of one app show one plain sentence per linked app, naming it and the
   reason, plus the hint "Back up Shop too" or "Move Shop too". Warn only: nothing is added, changed or blocked.
6. **States**: not scanned yet (hint to scan the server), no links, scan failed (last good facts kept with their time),
   and partial (some containers could not be read).

## Upgrade safety

One additive table. Old installs show "not scanned yet" until the next scan; nothing else changes. A downgrade ignores
the table.
