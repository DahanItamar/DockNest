# Safe Edit (beta)

Safe Edit changes a site from DockNest instead of over SSH: its Compose file, environment values, published ports or
image tag. Saving takes a backup first, applies the change behind the maintenance page and checks that the site comes
up. When it does not, DockNest puts the previous version back by itself.

Safe Edit is in beta until it passes DockNest's Linux Docker test on a release (see [AGENTS.md](../AGENTS.md)). The
design and its security rules are in [safe-edit.md](safe-edit.md).

## Who can use it

- **Administrators** open Safe Edit, review and save changes. Opening the editor and saving each ask you to verify
  your own authenticator again if you have not done so in the last 5 minutes, because Compose files can hold secrets.
- **Operators** see the history and the progress of a change, read-only.

Static sites have no containers, so they have nothing to edit.

## What you can change

| Tab | Compose sites | Single-container sites |
|---|---|---|
| Compose | The site's own Compose files, as text. | Not available. |
| Environment | Keys of the environment files the site uses. | The container's environment. |
| Ports | Published ports per service. | Published ports. |
| Image | The image tag per service. | The image tag. |

Ports and Image make the same text change you could make in Compose, and the review shows it. When DockNest cannot
find the one line to change (an anchor, a `${VARIABLE}`, `extends`, or several files that set it), the tab says
**Edit this in Compose**. When the image comes from a variable such as `image: shop:${TAG}`, change `TAG` in
Environment.

Environment values are write-only. A key shows **Saved**; **Replace** takes a new value. DockNest never shows, stores
or logs a value: it goes from your browser to the server over SSH and is written there with mode 0600 and the
file's original owner.

Not possible with Safe Edit: building images, editing Dockerfiles, nginx, certificates, DNS or data folders, removing
a service or renaming the project ("Remove it by hand"). Adding a service is allowed.

## What happens when you save

1. **Review.** DockNest checks the change on the server first and shows the differences. Environment values appear as
   `(changed)`. Review also says whether the data would be rolled back too, and warns when a new port is reachable
   from the internet, when a Compose file holds a password-like value inline ("Move secrets to Environment") and when
   the site has neither a health check nor a health URL (then only "running and stable" counts).
2. **Backup.** A normal, verified backup of the site.
3. **Prepare.** Copies of the current files and the current image IDs are kept on the server; new images are pulled.
   The site keeps running during the pull.
4. **Apply.** The maintenance page goes on, the files are written, and the services start with the new version.
5. **Check health.** Every service that ran before runs, is healthy where it has a health check, still runs after 60
   seconds, and the site's health URL (if set) answers. Time limit: 2 minutes, 1 to 10 in Advanced.
6. **Finish.** The maintenance page goes off.

You can cancel until Apply starts. After that, rollback is the undo.

## When the change does not come up

DockNest rolls back by itself: the original files come back byte for byte, the services start again with the
previous image IDs (never pulled again), and the health check runs again. When the image changed, the data comes back
too, in place (see "The data safety copy" below). The change is shown as **Rolled back** with the reason,
for example "The site did not become healthy in 2 minutes", and the **Change undone** alert is sent.

If the rollback itself fails, the site stays behind the maintenance page and the change **needs attention** (alert:
**Change needs you**). Choose:

- **Try again** runs the rollback once more.
- **Restore backup** restores the backup taken before the change through DockNest's normal restore, as a separate
  copy next to the site (it does not overwrite the live site). The maintenance page
  stays on until you have checked the site and turned it off.

While a change runs or needs attention, the site's backups, restores, moves and maintenance actions wait.

## The data safety copy

A new image version often changes its data on first start (database migrations). So when a change gives a service a
new image, DockNest also keeps the data:

- Just before writing the change, after the maintenance page is on, the site's services stop and DockNest copies the
  site's data on the server into its journal folder (`/var/lib/docknest/edits/<id>/data`): every named volume of the
  local driver and every data folder the site binds, keeping owners, permissions, extended attributes and symbolic links
  (links are copied as links, never followed). Compose and configuration files are not part of it; they come back from
  the file journal. Folders the site excludes from its backups are left out.
- The copy needs free disk space of at least 1.2 times the data size. With less, the change stops before anything is
  written: "Not enough free disk space for the safety copy." Review shows the size of the data.
- On rollback the services stop, each data folder gets exactly the copied contents back (files added since are
  removed), and the previous version starts.
- The copy is deleted after a change that comes up and after a rollback that works. If the rollback fails, the copy is
  kept and the change says "A safety copy of the data is kept on the server."
- Data on a volume of another driver (for example NFS) cannot be copied, so an image change on such a site is refused.
  Environment and port changes never take a copy.

## Refused changes

DockNest refuses a change with one plain reason when it would:

- change DockNest's own containers (update DockNest with its upgrade instead);

- add a privilege the site did not have: `privileged`, added capabilities beyond Docker's defaults, host network or
  namespaces, devices, `docker.sock`, `use_api_socket`, `gpus`, `runtime`, security options, a `docknest.*` or
  `com.docker.compose.*` label;
- mount a folder outside the site's own locations, a protected system path, or any path through a symlink;
- set an environment key starting with `COMPOSE_`, `DOCKER_` or `BUILDKIT_`, or a value with a line break;
- give a new image, command or environment to a service that already has host access ("Change it by hand");
- publish a port already in use on the server, or port 22 / the SSH port;
- remove a service.

If a file was changed on the server after you opened it, Review says "This file changed on the server. Reload it."
If it changes while the backup runs, the change stops before anything is written: "The files changed during the
backup."

Docker Compose 2.24 or newer is needed on the server.

## Limits

10 changes per site per hour, Compose files up to 256 KB, up to 200 environment keys of up to 8 KB each. A review is
valid for 15 minutes, once.

## API

The administrator API (`GET /api/sites/:id/edit`, `POST /api/sites/:id/edit/review`, `POST /api/sites/:id/edit/apply`,
`GET /api/site-edits/:id`, `GET /api/sites/:id/edits`, and the cancel, retry and restore-backup actions) is described
in [safe-edit.md](safe-edit.md).
