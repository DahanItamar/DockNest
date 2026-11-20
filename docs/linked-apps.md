# Linked apps

Apps on one server often depend on each other: one database serves several apps, two apps share a network or a volume,
or a container links to a container of another app. A container belongs to exactly one app, so a shared database is
backed up by one app while the others only use it. Backing up, moving or restore-testing one of them alone can leave a
copy that does not work. Linked apps shows these ties so you can act on them.

Linked apps is read-only and warn-only. DockNest never adds, changes or blocks anything because of a link.

## What is detected

When an administrator scans a server (Add app, or scanning the server again), DockNest reads, for each container, only:

- the Compose project and service names, and the service names in Compose `depends_on`;
- the names of the user-defined networks it is on (`bridge`, `host` and `none` are ignored);
- the names of the named volumes it mounts, and the host folders it bind-mounts;
- the containers it links to with legacy `links`.

Environment values, commands, other labels and file contents are never read for this. Nothing new connects to the server
and nothing runs on a timer: the facts come with the scan that already runs, and the links follow your apps at once
when you add, edit or archive one.

Each pair of apps gets one link, labelled with the strongest reason:

| Kind       | When                                                                                       | Warns |
| ---------- | ------------------------------------------------------------------------------------------ | ----- |
| `volume`   | Containers of both apps mount the same named volume or the same host folder.               | yes   |
| `link`     | A container of one app links to, or depends on (`depends_on`), a container of the other.   | yes   |
| `database` | The apps share a network, one side has a database on it and the other side something else. | yes   |
| `network`  | The apps share a user-defined network.                                                     | no    |

A network-only link is shown on the Map but never used for a warning.

A host folder and the folders inside it count as one: an app that mounts `/srv` and one that mounts `/srv/media` share
`/srv`. Host folders that unrelated containers commonly share never count: system files such as `/etc/localtime`,
`/etc/passwd` and `/etc/os-release`, `/dev`, `/proc`, `/var/log`, Docker's own `/var/lib/docker` and the Docker socket.

A network that more than four apps share, such as a reverse proxy network, links no pair of apps. It is listed once as a
shared network with its apps instead.

A container is a database when its app's settings choose a database engine for it; otherwise DockNest goes by the image
name, the same way it does when you back up (an image named like `postgres-exporter` or `redis-commander` is a tool, not a
database).

Containers that no app backs up are listed too when an app depends on them: it links to them, shares a volume or folder
with them, or reaches them as its database. Add them to an app to have them backed up.

## States

- **Not scanned yet**: the server has not been scanned since the update. Scan the server to see its links.
- **No links**: the apps on the server do not depend on each other.
- **Partial**: some containers or values could not be read, or the server has so many shared containers that DockNest
  stopped looking; the links shown come from the rest.
- **Scan failed**: the last good result stays, with the time it was taken.

## For developers

`GET /api/state` gives every server an `appLinks` object, for every signed-in role:

```json
{
  "checkedAt": "2026-11-19T08:00:00.000Z",
  "partial": false,
  "links": [
    { "appIds": ["<app id>", "<app id>"], "kind": "database", "via": "demo-db", "warns": true,
      "details": [{ "kind": "database", "via": "demo-db", "containers": ["demo-db", "demo-shop-web"] }] }
  ],
  "unowned": [
    { "container": "demo-cache", "appIds": ["<app id>"], "kind": "link", "via": "demo-cache",
      "details": [{ "kind": "link", "via": "demo-cache", "containers": ["demo-cache", "demo-shop-web"] }] }
  ],
  "hubs": [{ "network": "proxy", "appIds": ["<app id>", "<app id>", "<app id>", "<app id>", "<app id>"] }]
}
```

`checkedAt` is null until the first scan. `appIds` are sorted; `via` is the volume or folder, the linked or database
container, or the network the strongest reason came through. `warns` is false only for a `network` link; `unowned`
entries always warn. `linksOfApp(appLinks, appId)` in `shared/app-links.js` gives one app's links, strongest first, each
with `otherAppId`, and its `unowned` and `hubs` entries.
