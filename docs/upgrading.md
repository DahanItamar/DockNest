# Upgrading DockNest

Before rolling back to 2.5.0 or older, finish or cancel every site move ([moving-sites.md](moving-sites.md)): older
releases ignore move jobs but cannot continue or undo a move.

Before rolling back to 2.8.x or older, finish or cancel every automatic restore test and its clean-up ([restore-tests-guide.md](restore-tests-guide.md)). Older releases ignore test jobs and cannot continue a test or clean up its copy on the test server. The test server's safety timer removes leftovers in that case, but it is better to see "Clean up" finish first. Releases from 2.9.0 add new tables only (migration 9, `compatible: true`), so older releases run on the upgraded database. Restore test settings and history stay in the database and show again after you upgrade.

This page covers upgrades and rollbacks for a server installed with `git clone`, `scripts/setup.js` and `docker compose up -d --build`. It also lists what stays stable between versions.

Upgrades never move, rename or delete your volumes, secrets, certificates, site configuration or remote backups. Before the metadata schema changes, DockNest writes a snapshot of the database.

Before a release is tagged, its commit is upgraded from a real v2.0.0 Compose installation in CI, then downgraded and upgraded again with `scripts/upgrade.sh`; see [Release validation](release-validation.md) for what that run proves and what it does not.

## Upgrade with one command

From the DockNest checkout on the server:

```sh
scripts/upgrade.sh                    # newest final release
scripts/upgrade.sh --version v2.1.0   # a specific release
scripts/upgrade.sh --dry-run          # show the plan only
```

Since 2.2.0 the script also checks that the target is official before it changes anything, removes old upgrade files after a successful run, and can be driven by the [host updater](#host-updater-and-update-center). These parts are described below.

**First upgrade from v2.0.0.** v2.0.0 does not include this script. Fetch it from the target release and run it from the checkout:

```sh
git fetch --tags
git show v2.1.0:scripts/upgrade.sh > /tmp/docknest-upgrade.sh
sh /tmp/docknest-upgrade.sh --version v2.1.0
```

**Upgrading from 2.1.x to 2.2.0 runs 2.1's script.** The script that performs an upgrade is the one in the checkout you start from, so the hop to 2.2.0 uses the 2.1 script, not the 2.2.0 one. That hop has none of the 2.2.0 behavior below: no on-`main` or signature check, no cleanup of old upgrade files, and no exit 4 after a compatible migration (a failure after the schema changed ends with exit 5 and manual commands). It also does not pause DockNest self-backups: 2.1's hold covers site jobs only, so a self-backup that starts during the hop is not waited for. Run the hop outside your self-backup window. After it, the checkout holds the 2.2.0 script and every later upgrade behaves as described here. To get the 2.2.0 behavior on the hop itself, run the script from the target release, as for the first upgrade from v2.0.0 above (`git show v2.2.0:scripts/upgrade.sh`).

The script:

1. Refuses to continue if another `upgrade.sh` run holds the [script lock](#the-script-lock), if the target is not an official release (see [Verifying the target](#verifying-the-target)), if tracked files were edited (see [Customising without conflicts](#customising-without-conflicts)), if `data/master.key` or `data/setup.token` is missing, if the target release cannot upgrade from your version (`minUpgradeFrom`), or if Compose configuration is invalid.
2. Fetches release tags and shows the current and target versions. If the fetch fails it continues with the tags already in the checkout, so a rollback works offline.
3. Sets the deployment hold (`scripts/deployment-preflight.js hold`) so no new backups or restores start. It waits up to `--wait` seconds (default 600) for queued or running jobs, then stops. `--force` continues anyway; interrupted jobs then need recovery review.
4. Copies `.env`, `compose.override.yaml`, `data/master.key` and `data/setup.token` to `data/upgrade-backups/<time>-<from>-to-<to>/` with mode 0700. Each run gets a folder of its own with a `result` marker that records how the run ended. Only a later successful upgrade removes old folders, under the [retention rules](#what-is-removed-after-an-upgrade).
5. Checks out the release tag, then builds the new image (or pulls it in [image mode](#use-the-published-image)) while the old release keeps serving.
6. Stops the worker, which finishes in-flight work first, then starts the new API and worker. On first start the new code migrates the metadata after taking a snapshot.
7. Waits up to `--timeout` seconds (default 300) for `GET /api/version` to report the target version and for the worker to run. Then it lifts the hold, records the success in the backup's `result` marker and only then removes old upgrade files.

If the new release does not become healthy:

- **Schema unchanged:** the script checks out the previous commit, starts it again from the exact image recorded before the switch (so it works offline and never pulls), lifts the hold and exits with code 4. No data changed. Before it builds or pulls, the script tags that image `<repository>:pre-upgrade` (for example `docknest:pre-upgrade`), so the build moving `docknest:local` (or a pull moving a tag such as `latest`) cannot leave it without a name; Docker, the containerd image store in particular, may drop an image that has no name. After a success the tag becomes `<repository>:previous`.
- **Schema migrated, but only by compatible migrations:** if the previous release's own schema is at or above the compatibility floor of the migrated database (the rule in [Rolling back](#rolling-back)), the previous release runs on the migrated metadata as is. The script restores it, lifts the hold and exits with code 4. No data is discarded.
- **Schema migrated by an incompatible migration:** the script does not guess. It exits with code 5, keeps the hold, and prints the exact [rollback](#rolling-back) commands.

After exit 4 the script also removes the image it built or pulled for the failed target, best effort and without `--force`. It never removes an image a service runs or one recorded by a run that needs manual action. The backup folder of the failed run stays.

Any other failure after the hold is set (a step that errors, Ctrl-C, a signal) is handled the same way: the hold is released, the checkout and containers return to the previous release when the metadata is provably unchanged, and the status file ends with `ok: false`. It never stays at `ok: null`. A refusal after the hold (for example, no space for the configuration backup) also lifts the hold.

Reinstall boot recovery afterwards, if you use it. See [Boot recovery after upgrades](#boot-recovery-after-upgrades).

### Options and exit codes

| Option | Meaning |
| --- | --- |
| `--version vX.Y.Z` | Target tag. Default: the newest final `vX.Y.Z` tag (never a pre-release). |
| `--non-interactive` | Do not ask for confirmation. Implied when stdin is not a terminal. |
| `--allow-data-rollback` | Allows a downgrade that restores an older metadata snapshot. Required with `--non-interactive`. |
| `--status-file PATH` | Write progress as JSON, replaced atomically at each phase. |
| `--force` | Continue when jobs are still queued or running after `--wait`. |
| `--wait SECONDS` / `--timeout SECONDS` | Idle wait (default 600) and health wait (default 300). |
| `--dry-run` | Read-only plan: no fetch (it uses the tags already in the checkout), no hold, no lock, no status file, no containers started apart from reading the schema version. It also lists what the cleanup would remove after a successful upgrade. |
| `--no-prune` | Skip the cleanup of old upgrade files after a successful upgrade; keep everything. |
| `--no-verify` | Skip the on-`main` and signature checks of [Verifying the target](#verifying-the-target), for forks, mirrors and hosts without access to GitHub. Prints a warning. |
| `--capabilities` | Print the supported flags and status fields as JSON and exit. The host updater uses this to refuse a script it does not understand. |
| `--no-fetch`, `--expect-commit SHA`, `--expect-image-digest sha256:...`, `--upgrade-only`, `--request-id ID` | For the host updater, which has already verified the release: use the tags already in the checkout, build or pull exactly the verified commit and signed image digest, refuse anything that is not newer, and tag the status file. Not needed for manual runs. |

| Code | Result |
| --- | --- |
| 0 | Upgraded, or already running the target. |
| 1 | Usage error. |
| 2 | Refused before changing anything (edited files, missing secrets, unknown tag, unsupported path, downgrade without a matching snapshot, cancelled). |
| 3 | Jobs were still queued, running or awaiting recovery review. Nothing changed. |
| 4 | Failed, and the previous release was restored automatically: either before the schema changed, or after only compatible migrations ran (the previous release runs on the migrated metadata and no data is discarded). |
| 5 | Failed after an incompatible migration, or failed unexpectedly where the metadata could not be proven unchanged or compatible. The hold stays on. Roll back manually with the printed commands. |
| 6 | The automatic return to the previous release also failed. |

The status file is a single JSON object:

```json
{"phase":"health","from":"2.1.0","to":"2.2.0","startedAt":"2026-10-21T08:00:00Z","updatedAt":"2026-10-21T08:02:10Z","ok":null,"error":null,"rollbackHint":"git checkout <commit> && docker compose up -d --build && ...","warning":null,"reason":null,"schemaFrom":4,"schemaTo":null,"requestId":null}
```

`warning` is set only when the cleanup ran into a problem (the upgrade itself still succeeded). `reason` is set only when `ok` is `false`, from a fixed list (for example `verify-signature-invalid`, `verify-not-on-main`, `fetch-failed`, `jobs-did-not-finish`, `build-failed`, `pull-failed`, `migration-failed`, `health-timeout-api`, `health-timeout-worker`, `rollback-failed`, `interrupted`), otherwise `unknown`. `schemaFrom` and `schemaTo` are integers or `null`; `requestId` is the host updater's request id or `null`.

`phase` moves through `preflight`, `fetch`, `idle`, `backup`, `checkout`, `build`, `stop`, `restore-snapshot` (downgrades only), `start`, `health`, `rollback` (only after a failure), `release` and `cleanup`, and ends at `done` or `failed`. `ok` stays `null` while the script runs and is `true` or `false` at the end. The file has mode 0644 and contains no secrets.

### Verifying the target

Unless you pass `--no-verify`, a manual run checks that the target is an official release before it holds the deployment or changes anything:

1. The target tag's commit must be an ancestor of `origin/main`. Otherwise the run stops with exit 2. A checkout without `origin/main` is refused too; run `git fetch origin`.
2. For a target of 2.2.0 or later, the signed `docknest-release.json` and its `.sigstore.json` bundle are downloaded from the GitHub release and checked with `cosign verify-blob` against the release workflow's identity for that exact tag and commit. The manifest's `commit`, `tag`, `version` and `repository` must match, and `prerelease` must be `false`. In [image mode](#use-the-published-image) the signed image digest is used for the pull. Targets before 2.2.0 have no signed manifest and get only the first check.

This needs `curl` and `cosign` on the host. If `cosign` is not installed (and the host updater's pinned copy is absent), the signature check is skipped with a warning and the on-`main` check still applies. If `curl` is missing or the download fails, the run stops with exit 2 and changes nothing. A host that cannot reach GitHub (offline or air-gapped) must pass `--no-verify`, which skips both checks; a rollback to a tag that is already in the checkout then works offline. Only the host updater compares the numeric GitHub repository and owner ids, so a manual run trusts the repository name.

### The script lock

Only one `upgrade.sh` run can change the installation at a time. A run takes the folder `data/.upgrade.lock` (created atomically, holding its PID) when it starts and removes it when it ends. A second run, including one started by the host updater, stops with exit 2 and names the PID. `--dry-run` takes no lock.

A lock whose process is gone is taken over automatically, using a second folder, `data/.upgrade.lock.takeover`, as a short mutex so two runs can never both own it. If the machine lost power in the middle of that takeover and later runs keep refusing, confirm that no `upgrade.sh` is running, then remove both folders:

```sh
rm -rf data/.upgrade.lock data/.upgrade.lock.takeover
```

### What is removed after an upgrade

After a successful upgrade, once the success is recorded, the script cleans up old upgrade files. The cleanup never changes the outcome: if it fails or is interrupted, the upgrade is still a success (exit 0) and the status file carries a `warning`. It has its own two-minute limit. It removes:

| What | Rule |
| --- | --- |
| `data/upgrade-backups/<time>-<from>-to-<to>/` | Keeps the newest 5, counting the run that just finished. A backup is also kept, whatever its age, when its run ended with exit 5 or 6 or never recorded an exit code (an interrupted run), because it holds the files for a manual rollback. Folders written before 2.2.0 have no marker and count as ordinary. |
| Rollback copies in the state volume (`upgrade-snapshots/pre-downgrade-*` and `pre-rollback-*`) | Keeps the newest 2 of each kind. The `state-v*-to-v*` snapshots are rotated separately (see [Rolling back](#rolling-back)). A rollback copy that was removed cannot be restored: to go back that far, pull or rebuild the old release. |
| Docker images of earlier releases | Keeps exactly two DockNest images: the one `api` and `worker` run and the previous release's, which is tagged `<repository>:previous` (`docknest:previous` in source mode). Removes every other image of this installation's repository (source mode: the repository of the local build name, normally `docknest`, so also legacy tags such as `docknest:sqlite-online` or `docknest:direct-<sha>`; image mode: the image name in `DOCKNEST_IMAGE`), the untagged images this installation recorded in its upgrade backups, and untagged images that carry the DockNest label `io.github.dahanitamar.docknest` (older releases and build stages left by `docker compose build`; images built before this label existed are removed only when recorded). Kept: any image a container uses (running or stopped, of any project), any image tagged `:previous`, `:pre-upgrade` or with the name the services run (checked by tag, not only by ID), images recorded by a run that needs manual action, and any image that is also tagged in another repository. The step is skipped when the running or previous image ID, or the containers' images, cannot be read. It uses `docker image rm` without `--force`; it never runs `docker image prune`, `docker system prune` or `docker builder prune`, and never touches other repositories. A second DockNest checkout on the same host that uses the same repository keeps the images its containers use; its unused ones are removed too. |
| Docker build cache (source mode) | Not removed. Docker cannot limit `docker builder prune` to one project, so trimming it would also clear other projects' cache. The summary prints the optional command `docker builder prune --filter until=168h`, which frees build cache older than 7 days (never images, containers or volumes; a later build is only slower). |

The run ends with one summary line, for example `Cleaned up: 3 old DockNest images`, which is also written to the status file as `cleanup`. A failed (exit 4, 5, 6) or interrupted run does not clean up. Use `--no-prune` to keep everything, or `--dry-run` to see the list first. Upgrade backups hold `.env` and secrets; keep your own copy of `data/master.key` regardless.

**Upgrading from 2.4.1 or earlier.** An upgrade always runs the script of the release you are on, so the first upgrade away from 2.4.1 or earlier still uses the old image handling. To keep that release's image for a rollback, tag it yourself first: `docker tag docknest:local docknest:previous` (image mode: `docker tag <DOCKNEST_IMAGE> <image name>:previous`). From the next upgrade on, the script does this itself.

## Manual upgrade

```sh
git status --short --untracked-files=no                     # must print nothing
docker compose exec api node scripts/deployment-preflight.js hold
cp -p .env data/master.key data/setup.token /secure/backup/  # plus compose.override.yaml if you have one
git fetch --tags && git checkout v2.1.0
docker compose build
docker compose stop worker
docker compose up -d
docker compose logs --tail=50 api                           # look for "metadata schema migrated"
curl -fsS http://127.0.0.1:${HOST_PORT:-3000}/api/version     # {"version":"2.1.0","schemaVersion":2}
docker compose exec api node scripts/deployment-preflight.js release
```

Do not run `git pull` on a release checkout. Releases are tags, so the checkout is a detached HEAD.

## Rolling back

**Back to the previous release's image.** After a successful upgrade the previous release's image is tagged `docknest:previous` (image mode: `<image name>:previous`) and is kept until the next successful upgrade. The script prints the exact command, for example `git checkout <previous commit> && docker tag docknest:previous docknest:local && docker compose up -d --no-build` (image mode: `DOCKNEST_IMAGE=<image name>:previous docker compose up -d --pull never`, and keep the previous `DOCKNEST_IMAGE` in `.env`). Older releases' images are removed, so to go back further, check out that tag and rebuild (`docker compose up -d --build`) or pull it. Hints printed by 2.4.1 and earlier name the image by its ID (`docker tag sha256:… docknest:local`); if `docker image inspect` says "No such image", rebuild from the previous tag instead.

**Compatible schema (no data loss).** A migration marked `compatible: true` only adds tables or indexes that older code ignores. Migration 2 (`boot_recovery_installs`) is one. When every migration newer than the target release is compatible, the older release runs on the migrated database as is: `scripts/upgrade.sh --version <older tag>` checks out the tag, rebuilds and starts it, with no snapshot restore and no `--allow-data-rollback`. This is how the common 2.1 to 2.0.0 rollback works. By hand: check out the previous tag and run `docker compose up -d --build`. v2.0.0 has no `/api/version`; use `/healthz` instead. Releases from 2.1 onward record the oldest usable schema (`schema_compat_floor` in `settings`) and start on a newer, compatible database; v2.0.0 has no schema check at all.

**Incompatible schema.** If any newer migration is not compatible, an older release refuses to start. It logs `DockNest metadata schema vN is newer than this release understands` and names the snapshot to restore. Snapshots live in `DATA_DIR/upgrade-snapshots` (inside the `docker-backup-manager_state` volume) as `state-v<from>-to-v<to>-<UTC time>.sqlite`. The newest five, plus the newest of every distinct from/to pair, are kept. A failing migration under a restart policy reuses one snapshot instead of copying the database on every boot, and a snapshot needs 1.2 times the database size plus 64 MiB of free space, otherwise the upgrade stops before changing anything. Restoring a snapshot discards every job, backup record and setting change made after it. Backup files on storage are not touched, but backups taken since then are no longer listed. `scripts/upgrade.sh --version <older tag> --allow-data-rollback` does all of this for you. To do it by hand:

```sh
docker compose stop api worker
docker compose run --rm --no-deps --entrypoint /bin/sh worker -ec 'ls -l /data/upgrade-snapshots'
docker compose run --rm --no-deps --entrypoint /bin/sh worker -ec '
  cd /data && keep=upgrade-snapshots/pre-rollback-$(date +%s) && mkdir -m 700 "$keep"
  for f in state.sqlite state.sqlite-wal state.sqlite-shm; do [ ! -e "$f" ] || mv "$f" "$keep/"; done
  cp upgrade-snapshots/state-v0-to-v2-20261021T080000000Z.sqlite state.sqlite && chmod 600 state.sqlite'
git checkout v2.0.0 && docker compose up -d --build
docker compose exec api node scripts/deployment-preflight.js release
```

Keep the `pre-rollback-*` folder until you have checked the result. The upgrade backup folder holds the `.env` and secrets that belong to the previous release. Copies made by the host updater can belong to root; after copying `master.key` or `setup.token` back, give them their original owner again (`sudo chown 1000:1000 data/master.key data/setup.token`, the api container's user) or the api cannot read them.

## Alerts after upgrading to 2.10

2.10 moves alert logins from the Map to Administration, **Connections**, and adds eleven providers. Nothing needs doing:

- Migration 10 (`alert-connections`, compatible) adds new tables and copies every 2.8 alert node, line, chat, inbox and
  waiting message into them. Sealed logins are copied as they are, never opened. Every node keeps its id, its lines and
  its destination, and the first message after the upgrade goes to the same chat or inbox (it reads a little richer:
  a title, a plain reason and a link to the job).
- A Telegram bot used for several chats becomes one Connection per chat, named after the bot and the node. A node that
  had no credential shows "Needs a connection" and sends nothing, as it showed "Needs a credential" before.
- A credential no node used becomes a Connection that says "Add the chat ID" or "Add recipients" until you complete it.
- "Operators can manage alerts" and "Allow private network" start off, so alerts stay administrators only and private
  addresses stay closed, exactly as in 2.8. An Email relay on a private address that an administrator set keeps working.
- API: `/api/alerts/credentials` and `/api/alerts/channels` are removed; use `/api/connections` and
  `/api/alerts/nodes` ([alerts.md](alerts.md), "API"). `channelId` in `/api/alerts/rules` is deprecated in favour of
  `nodeId` and still accepted in 2.10.

**Going back to 2.9.** The 2.8 alert tables are left as they were, so 2.9 starts on the migrated database and keeps
sending with the alert setup from upgrade time. Changes made in 2.10 are not visible to 2.9. Changes made in 2.9 after
that are not copied again when you upgrade once more; the Connections page then says so, and you enter them again.
Replacing a secret or deleting a migrated Connection in 2.10 also removes its 2.8 copy, so after going back those 2.8
nodes need a credential and send nothing.

## Backup copies in 2.11

Storage per site and backup copies are new in 2.11. Nothing needs doing and nothing changes until you configure them:

- Migration 11 (compatible) only adds tables (per-site storage, copy list and copy status). Existing sites keep using
  the default destination with no copies, and existing backups are not copied or moved.
- After you add a copy destination to a site, each new backup is also copied there in the background. Copies are the
  same encrypted package, so the same master key opens them.
- Recovery kits are also written to every other destination that holds copies.

**Going back to 2.10.** Schema 11 is compatible, so 2.10 starts on the same database. It ignores copy settings and
backs up and restores from the main copy only. Copies already made stay where they are. 2.10 never touches copy files, but it can delete a backup row (for example when
retention removes it or its main package is missing); the copies of such a backup are left behind, and 2.11 deletes
them on its next maintenance run after you upgrade again.

## Incremental backups in 2.12

Incremental backups are new in 2.12 and are off for every site. Nothing needs doing and nothing changes until you turn
them on for a site under its backup settings ("Incremental backups (beta)"):

- Migration 12 (compatible) only adds tables and settings. Existing backups stay complete packages and keep working.
- After you turn the option on, the next backup is a full one. By default a full backup is made every 7 backups (the
  setting "Full backup every" takes 2 to 31), and the backups in between hold only the files that changed in your
  mounts. Every backup made while the option is on is a format 2 package in the same encrypted format, so the same
  master key opens them.
- A full backup is kept as long as an increment that needs it is kept, so a few more packages than your retention count
  can stay. Pinning an increment pins its chain.
- Turning the option off makes the next backup a plain full package. Existing chains stay restorable.

**Going back to 2.11.** Turn incremental backups off for every site, then make a backup. With the option off, that
backup is a plain full package that 2.11 restores. 2.11 starts on the same database (the migration is compatible), but
it refuses every format 2 package, increments and the full backups made while the option was on, with the plain message
"Unsupported or incomplete backup", and its retention does not know that an increment needs its full backup. If the
database still holds increments, the Update Center warns before a downgrade. Backups made while the option was off are
plain packages and restore on 2.11 as before. To recover a format 2 backup without DockNest or on 2.12 again, see
[independent recovery](independent-recovery.md).

## Protected mounts are no longer copied (2.11.1)

**This changes what new backups contain.** From 2.11.1, a selected container's bind mount of password files, sudo
rules or SSH keys is not copied into new backups. Examples are a `.ssh` folder (a Gitea or Forgejo `git` user's keys,
`/root/.ssh` in a CI runner), `/etc/ssh`, `/etc/sudoers.d`, `/etc/shadow`, or a system folder such as `/etc` or
`/root` that contains them. Nothing needs doing to keep backups running:

- Scheduled backups of such sites keep working. The mount's place in the package holds an empty placeholder, and the
  backup is recorded with a warning that names each mount that was not copied. The site's readiness check shows the
  same list as a non-blocking item.
- Recover these files separately, for example from your own secrets or key management. A restored copy gets the empty
  placeholder, never the real keys.
- A move refuses such a site and asks you to move it by hand, because DockNest never writes these locations.
- Backups made before 2.11.1 are unchanged and still hold what they captured.

### Key folders inside copied mounts (2.12.1)

From 2.12.1 the same rule reaches inside the mounts that are copied. An entry named `.ssh` or `.gnupg` anywhere in a
copied bind mount (for example `/home/deploy` mounted into a container, which holds `~/.ssh` and `~/.gnupg`) is left
out of the backup; the rest of the mount is copied as before. Names that only contain these words, such as
`x.ssh` or `.sshrc`, are still copied. Docker volumes are the container's own data and are copied whole.

- The job result and the readiness check list each folder that was left out, as a warning. Recover these keys
  separately; the restored mount simply has no such folder.
- With incremental backups, a chain whose full backup still holds one of these folders starts again with a full
  backup the first time 2.12.1 finds it. Later increments continue normally.
- A bind mount of a `.gnupg` folder itself is now a protected mount, like a `.ssh` mount: it is not copied, and a
  move refuses the site.

## Restored files never keep setuid or setgid (2.12.1)

Restores, restore tests and moves clear the setuid and setgid bits on every restored file and remove file
capabilities (`security.capability`). Folders keep their setgid bit (new files inherit the folder's group) and the
sticky bit. There is no setting to keep them: container images bring their own programs back through Docker, and
application data does not need privileged programs. If a restored application really needs one, set it again by
hand after checking the file. A static website that holds such a file restores without the bits; static backups
made before 2.12.1 that hold one no longer pass the restore check.

## Use the published image

Releases from 2.1 onward are published as `ghcr.io/dahanitamar/docknest` with the tags `X.Y.Z`, `X.Y`, `X` and `latest`. Only final releases are published; release candidates are validated privately and get no image or GitHub Release. Building from source stays the default. To use the image, add `DOCKNEST_IMAGE=ghcr.io/dahanitamar/docknest:2.1.0` to `.env` and use the override in `compose.override.example.yaml` (Docker Compose 2.24 or later). Use a tag, not a digest. To upgrade, run `scripts/upgrade.sh --version v2.1.1`: the script records the current tag and image ID in the upgrade backup, switches only the tag for its own `pull` and `up` commands, and writes the new tag to `.env` after the release is healthy. If the start fails, it returns to the recorded image ID (`up --pull never`), not to whatever tag `.env` names. The signature is not verified by the script; use the cosign command below when you want that.

The release workflow runs only for a final `vX.Y.Z` tag whose commit is on `main` and has a successful `Verify` run and a successful [release validation](release-validation.md#release-order), and publishes `linux/amd64` only. On ARM hosts keep building from source.

Every pushed digest is signed with cosign keyless signing from the release workflow. Verify an image before using it:

```sh
cosign verify ghcr.io/dahanitamar/docknest:2.1.0 \
  --certificate-identity https://github.com/DahanItamar/DockNest/.github/workflows/release.yml@refs/tags/v2.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Each GitHub Release also includes `docknest-release.json`:

```json
{"version":"2.1.0","schemaVersion":2,"minUpgradeFrom":"2.0.0","image":{"name":"ghcr.io/dahanitamar/docknest","digest":"sha256:…"},"notes":"docs/releases/2026-10-22-v2.1.md"}
```

From 2.2.0 the manifest also names the release's `tag`, full `commit` SHA, `repository` and `prerelease` (always `false`), the optional `highlights` taken from the notes front matter ([template](releases/TEMPLATE.md)), and an `updater` block with the SHA-256 of each host updater file (empty until the updater's self-update ships). It is signed keylessly as well: the release carries `docknest-release.json.sigstore.json`, and the workflow verifies both signatures before it publishes the release. Verify the manifest yourself with:

```sh
cosign verify-blob docknest-release.json --bundle docknest-release.json.sigstore.json \
  --certificate-identity https://github.com/DahanItamar/DockNest/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Release notes are also bundled in the image under `docs/releases/`. Name new notes `YYYY-MM-DD-vX.Y.Z.md`. A `vX.Y.md` file also covers the `X.Y.0` release.

DockNest checks for updates only after an administrator agrees (see [the Update Center flow](#the-update-center-flow)). The **About** section in preferences shows the running version and links to the releases page.

## Boot recovery after upgrades

Most remote operations stream the current helper over SSH, so they update automatically. Boot recovery is the exception: installing it copies `remote/helper.py` and `remote/boot_recovery.py` onto the host, and those copies go stale after an upgrade. DockNest records the SHA-256 of the installed bundle. Site state (`GET /api/state`) and `GET /api/sites/:id/boot-recovery` report `bootRecoveryOutdated: true` when the copy differs from the running release. This includes installs made before fingerprints were recorded. Upgrades never connect to your hosts. After each upgrade, reinstall boot recovery on the affected sites (`POST /api/sites/:id/boot-recovery`, administrators only) once no work is active. The dashboard does not show this flag yet.

## Customising without conflicts

The upgrade script refuses to run if tracked files are edited, because an upgrade would overwrite those edits. Put your changes where git never looks:

- `.env` for `APP_ORIGIN`, `SECURE_COOKIES`, `HOST_PORT`, `APP_DOMAIN`, `DOCKNEST_IMAGE` and other variables.
- `compose.override.yaml` for Compose changes such as ports, extra mounts, resource limits or image mode. Copy `compose.override.example.yaml` to start. Compose merges it automatically, and git ignores it.
- `data/` for secrets.

If `git status` lists a modified file, move the change into one of these, then run `git restore <file>`.

## Stability contract

DockNest follows [Semantic Versioning](https://semver.org/). Within a major version (2.x), the following stay compatible. A new release may add to them but will not rename, remove or reinterpret them.

| Area | Stable items |
| --- | --- |
| Environment variables | `APP_ORIGIN`, `SECURE_COOKIES`, `HOST_PORT`, `APP_DOMAIN`, `PORT`, `HOST`, `NODE_ENV`, `DATA_DIR`, `BACKUP_DIR`, `BACKUP_STORAGE`, `MASTER_KEY_FILE`, `SETUP_TOKEN_FILE`, `ALLOW_LOCAL_BACKUP_STORAGE`, `TRUST_PROXY` (new in 2.2.0, optional, unset by default), `STORAGE_HOST`, `STORAGE_PORT`, `STORAGE_USERNAME`, `STORAGE_HOST_KEY_SHA256`, `STORAGE_PRIVATE_KEY_FILE`, `STORAGE_PASSWORD_FILE`, `STORAGE_ROOT`, `STORAGE_CAPACITY_BYTES`, and the optional `DOCKNEST_IMAGE`. |
| Secret files | `./data/master.key` (base64 32-byte key) and `./data/setup.token`, mounted as the Compose secrets `master_key` and `setup_token` at `/run/secrets/master_key` and `/run/secrets/setup_token`. |
| Compose | Project `docknest`; services `api`, `worker` and `proxy` (profile `https`); volumes `docker-backup-manager_state`, `docker-backup-manager_caddy_data` and `docker-backup-manager_caddy_config` (legacy names kept on purpose, so certificates and state carry over), and, from 2.2.0, `docknest_updater` (mounted read-only into `api` only; empty unless the host updater is installed); loopback API port `127.0.0.1:${HOST_PORT:-3000}`. |
| `DATA_DIR` layout | `state.sqlite` with its `-wal` and `-shm` files, `worker.lock`, `upgrade-snapshots/`, `manager-backups/`, `private-exports/`, and `backups/` in local mode. Snapshot names follow `state-v<from>-to-v<to>-<UTC>.sqlite`. |
| Sessions | The `dbm_session` cookie and the `x-csrf-token` header. An upgrade keeps valid sessions, except the one-time v2.0.0 cleanup of legacy sessions without timestamps. |
| Site configuration | The JSON fields accepted by `POST /api/sites`: `kind`, `documentRoot`, `containers`, `stagingRoot`, `deliveryMode`, `sqliteIntegrityCheck`, `exclusiveSourcesConfirmed`, `stopTimeout`, `shutdownProfile`, `cleanShutdownConfirmed`, `unresolvedDependencies`, `services`, `configFiles`, `mountExclusions`, `mountExclusionsConfirmed`, `restoreReferences`, `temporaryMemoryFolders`, `composeFiles`, `externalReferencesConfirmed`, `maintenanceRequired`, `maintenanceProbeOrigin`, `maintenancePublicUrl`, `domains`, `healthUrl` and `maintenance`. Saved configurations keep loading. New fields always get defaults. |
| Public endpoints | `GET /healthz` returns `{status}` and `GET /api/version` returns `{version, schemaVersion}`. Neither needs a session. From 2.2.0, `GET /api/updates/progress` is also public and returns `{active, phase, to, state, stale, updatedAt, events: [{phase, at}]}`, nothing else, rate limited per client address (120 a minute); its fields may gain values but are not renamed. The update lock view relies on these endpoints to see the new release come up. |
| Backup formats | DBM1 encrypted payloads (`scripts/decrypt-backup.js`), manifests and recovery kits written by any 2.x release stay readable by later 2.x releases. |

Not covered: internal module APIs, database table layout (use the API), the CSS and markup of the dashboard, and authenticated JSON fields not listed above.

### Deprecation policy

- A deprecated item keeps working for at least one minor release. While it is deprecated, DockNest logs a warning at startup or on use, and the CHANGELOG lists it under **Deprecated**.
- Breaking changes happen only in a new major version. That release includes a migration guide in `docs/releases/` and sets `minUpgradeFrom` when intermediate releases are required.
- Schema migrations only move forward. A release never edits or renumbers a migration that has already shipped. Patch releases add migrations only for urgent fixes, and the release notes say so.
- A downgrade across incompatible migrations needs the matching pre-upgrade snapshot. Across compatible (purely additive) migrations, and within the same schema, downgrades are safe.

## Schema migrations (contributors)

`src/migrations.js` holds an ordered list of migrations. The database version is stored in `PRAGMA user_version`, which lives in the database header. It changes in the same transaction as the DDL and survives `VACUUM INTO` and the backup API. A v2.0.0 database reads as 0, so no extra `schema_migrations` table is needed.

On startup, `src/db.js` takes `BEGIN IMMEDIATE` with a long busy timeout, so when the API and worker start together only one of them migrates. If any migrations are pending on a non-empty database, it first writes a `VACUUM INTO` snapshot through a second connection. It then applies the pending migrations, sets `user_version` and commits. A failed migration rolls back completely. A version higher than the code knows stops startup.

Migration 1 (`baseline`) is the exact v2.0.0 startup schema. It is repeatable: it runs on every start, as v2.0.0 did. Only additive `CREATE ... IF NOT EXISTS` statements may be appended to it. Every other change needs a new numbered entry. Add `compatible: true` only to an entry that creates new tables or indexes and changes nothing existing; anything that alters, drops, rewrites or reinterprets existing data must not carry it, because older releases would then misread the data. Keep each entry on one line starting with `{ version: N,`, because `scripts/upgrade.sh` reads the highest number and the compatible flags from that pattern (`tests/upgrade-script.test.js` checks it against the real file). A failed snapshot leaves no `.partial` file, and stale ones are removed at the next start. `scripts/release-manifest.js` imports `schemaVersion` directly. Tests: `tests/migrations.test.js` (unit) and `npm run test:upgrade -- vX.Y.Z` (the real released code against the current API, run by the CI `upgrade` job for every final tag).

## Host updater and Update Center

The containers never get the Docker socket. In-app updates therefore go through a small root service on the host, the host updater, which you install once. It receives a request over a Unix socket, verifies the release itself, and then runs `scripts/upgrade.sh`. The design is in [update-center.md](update-center.md) and the threat model in [updater-threat-model.md](updater-threat-model.md). The host updater is optional: without it, DockNest upgrades exactly as before with `scripts/upgrade.sh`.

**Status of this work.** The broker, installer and the `upgrade.sh` flags are implemented and covered by unit and script tests (`updater/test_broker.py`, `tests/host-updater.test.js`, `tests/upgrade-script.test.js`). The Update Center page, the update request path and the update lock have unit, API and mocked-browser tests (`tests/update-requests.test.js`, `tests/update-transport.test.js`, `npm run test:updates`). None of it has been validated on a real Linux Docker host: the browser test uses a mocked API and proves the page, not a real update, rollback or restart.

### Install the host updater (once)

From the DockNest checkout on the host:

```sh
sudo scripts/install-updater.sh              # install
sudo scripts/install-updater.sh --status     # broker state and the last result with its rollback hint
sudo scripts/install-updater.sh --ack        # lift the "needs host acknowledgement" block
sudo scripts/install-updater.sh --repair     # reinstall broker, cosign, units and status directory; keeps state
sudo scripts/install-updater.sh --uninstall  # remove units and code; keeps /var/lib/docknest-updater
```

It needs Linux with systemd, Python 3.9 or later, `git`, `docker`, `curl`, `flock` and `setpriv` (util-linux 2.35 or later) and `systemd-analyze`. It installs a socket-activated systemd unit, downloads a `cosign` pinned by version and SHA-256 into `/usr/local/lib/docknest-updater`, and creates an unprivileged `docknest-verify` account that is used only to verify releases. It never adds anyone to the `docker` group, never changes ownership of the checkout and stores no secret. The upgrade itself runs as the checkout's owner, who must be root or already in the `docker` group. The first install verifies the release you are running (signed manifest, tag on `main`, image digest in image mode) and records it; if that fails, nothing is enabled.

The installer refuses:

- **Rootless Docker or user-namespace remapping**, and **Docker Desktop**. Update those from the command line with `scripts/upgrade.sh`.
- **A second install.** One updater per host. Use `--repair` or `--uninstall` from the checkout it was installed for.
- A host where exactly one running `api` container of the `docknest` project is not found, where the `docknest_updater` volume is missing (start DockNest 2.2.0 or later with `docker compose up -d` first) or is not a plain local volume, or where a required tool is missing.
- `--repair`, `--ack` and `--uninstall` while an in-app upgrade is running.

**Command-line upgrades on a host with the updater.** The updater only accepts a request when it has verified the installed release itself and recorded its commit (`/var/lib/docknest-updater/pins.json`). Run `scripts/upgrade.sh` as the checkout's owner, never with `sudo` on a checkout that belongs to another user. When `upgrade.sh` already runs as root (a root-owned checkout), from 2.11.1 it records the release itself after a healthy run, through the installed broker and with the same checks as the installer (signed manifest, tag on `main`, image digest in image mode). This can take a few minutes. Otherwise run `sudo scripts/install-updater.sh --repair` after a command-line upgrade. From 2.12.1 the script ends such a run with an `ACTION NEEDED (host updater)` block that gives the reason and the exact command for your checkout (`cd '<checkout>' && sudo scripts/install-updater.sh --repair`), and writes the same text to the status file's `warning`. This happens when the run is not root (a checkout owned by another user), when root ran it on a checkout that belongs to another user, and when recording the release failed, timed out or met a running update. The exit code stays 0, because DockNest runs the new release; only in-app updates wait for the repair. `--repair` also clears an earlier "cannot confirm which version is installed" refusal for that version. Until the release is recorded, the Update Center refuses with "The host updater has not verified the installed version yet" and shows the `--repair` command. A host without the updater is not affected.

In image mode, in-app updates need `DOCKNEST_IMAGE=ghcr.io/dahanitamar/docknest:<version>`. An install whose `DOCKNEST_IMAGE` names a mirror or has no tag is refused in-app (`state-mismatch`, nothing changed), because its image could not be verified; upgrade it with `scripts/upgrade.sh`.

The `docknest_updater` volume is mounted read-only into the `api` container only. It carries the socket and an allow-listed copy of the status.

After an upgrade that needs a person to look at the host (exit 5 or 6, an interrupted run, an unexpected exit or repeated automatic rollbacks) the updater blocks itself. `--status` names the reason and shows the rollback commands. Once you have checked the host and released the deployment hold (`docker compose exec api node scripts/deployment-preflight.js release`), run `sudo scripts/install-updater.sh --ack`; it refuses while the hold is still on. The updater also allows one run at a time, a 60-second cool-down and six runs a day, and stops a run after two hours.

### The Update Center flow

Administrators get **Update Center** in the sidebar (Administration), with the tabs Overview, What's new and History. The design is in [update-center.md](update-center.md).

1. **Consent, asked once.** At the first administrator sign-in DockNest asks whether it may check GitHub daily. The first answer wins; a second administrator is told the recorded answer. Until someone says yes nothing is sent. The Overview tab has a switch to change it later.
2. **Check.** With checks on, the worker asks GitHub once a day, and an administrator can use **Check now** (at most one real call a minute). The result is advisory display data. The destinations and what GitHub sees are in [security.md](security.md#update-checks-outbound-requests). The sidebar shows a badge when a newer final release is cached.
3. **Set up the host updater.** If the updater is not installed, the page shows the `sudo scripts/install-updater.sh` step and notices when it connects. If the updater is too old, blocked or not responding, the page says so and how to fix it (`systemctl status docknest-updater`, `--repair`, `--ack`). Without the updater the page offers the command-line route instead.
4. **Update.** An administrator selects **Update to vX.Y.Z**, reads what will happen, and confirms with the shared password and a fresh authenticator code. Only then does `POST /api/updates/requests` send one request over the updater's Unix socket. The API decides eligibility itself (a newer final release, the updater present and unblocked, no deployment hold, no recovery review pending); the host updater then decides again: it accepts upgrades only, rechecks the signed manifest and that the tag is on `main`, and runs `scripts/upgrade.sh --non-interactive --upgrade-only --no-fetch --expect-commit <sha>` as the checkout's owner. Nothing is installed unattended, and downgrades stay a command-line task.
5. **Progress and the update lock.** While a request is active, the API answers every request with `423 {"error":"UPDATE_IN_PROGRESS"}` except a short list: `GET /api/version`, `GET /api/updates/progress`, `GET /api/updates` and `/api/updates/status`, `GET /api/auth/status`, signing out, and an administrator closing a stale request. The browser then shows only the lock view, which replaces every page, sign-in included, and reads the public progress. The API restarts during the upgrade, so the lock view keeps polling and shows its own result when DockNest answers again. The update status the API reads from the `docknest_updater` volume (`status.json`, `current.json`, `service.json`) is untrusted display data.
6. **Result.** A successful update returns to the page with a notice. A failed one ends with the same exit codes and rollback behavior as a manual run: an automatic return (exit 4) allows a retry once, and a second automatic return for the same version blocks that version until `sudo scripts/install-updater.sh --ack`. A run that needs manual action (exit 5 or 6) blocks updates and keeps the lock view's message until the operator runs the rollback commands from `--status`, releases the hold and runs `--ack`.

If the updater stops reporting progress (no heartbeat for 2 minutes, or no phase change for 15 minutes, 45 while building), the lock view marks the update as stale and an administrator can close the record after checking the host. The API closes a request that never ran or has outlived the updater's two-hour limit by itself. Closing a record does not stop anything on the host.

**Update history.** The History tab lists in-app runs together with versions that were installed from the command line, with the outcome (installed, rolled back, needs manual action, not changed).

### Recovery kits and the hold

Restoring a recovery kit (`node scripts/recovery-kit.js restore`) writes into a new directory and clears the deployment hold in the restored state, because a kit taken during a hold would otherwise restore a manager that refuses all work. Exporting a kit is refused while the hold is on. Since the restore clears the hold, it refuses with "A DockNest update is running on this host" while the host updater reports a run. The guard reads the updater status at `/run/docknest-updater/status`, which exists only inside the `api` container, so run the restore there (`docker compose exec api node scripts/recovery-kit.js restore ...`) when you want the guard to apply. On a recovery machine without the updater the status is absent and the restore proceeds. If the refusal is stale and you are in disaster recovery, retry with `--ignore-updater`; it prints a warning, and you must not put the restored state in service while an update really is running.
