# Live checks for 3.0.0

What the automated tests cannot prove. Each line is a check on real systems, done with fake or test data only, before 3.0.0 is
called validated. A real backup or restore is not marked validated without a Linux Docker run (docs/release-validation.md).

## Cloud drives (docs/cloud-drives.md)

- [ ] Google Drive: connect by pasting the address, back up, restore, then revoke access in the Google account and confirm Needs sign-in, the paused backups, one alert, and Reconnect clearing it.
- [ ] OneDrive (personal, then work or school): the same, including the drive choice.
- [ ] Dropbox: the same.
- [ ] Real `rclone authorize` output: the token paste (flow B) and your own app ID (flow C) accept what the pinned rclone prints.
- [ ] WebDAV (Nextcloud) and an SMB share: connect, back up, restore, wrong password message.
- [ ] A rate limit from a provider ends the step with the plain message and recovers at the next run.
- [ ] Local folder on a USB disk and on a NAS folder, including the same-disk warning.
- [ ] The amd64 image builds, the pinned rclone checksum matches, and other CPU architectures say cloud drives are unavailable.

## NAS servers (docs/nas-servers.md)

- [x] The runtime image is built for amd64 and loaded over SSH (`docker load`): covered by the required Linux integration job (`scripts/integration-helper-runtime.js` on a nested host, tar from `scripts/build-helper-runtime.sh`, also built by release validation). Still a hardware check: a real NAS with no Python.
- [x] TrueNAS SCALE 25.x lab: connect, discover apps, back up, restore test (see the 2026-11-24 results); 24.04 is refused with the Kubernetes message (unit tests only).
- [ ] Unraid (needs a USB-stick test machine): connect, key persistence after reboot, template apps discovered, backup and restore.
- [ ] Unraid Compose Manager stacks are reported as unsupported, not half-backed-up.
- [ ] Synology DSM: connect with a sudo user, Container Manager projects, backup and restore.
- [ ] A NAS user without passwordless sudo gets the one-line fix.

## Podman and rootless Docker (docs/podman-rootless-adr.md)

- [ ] Rootless Podman on a VM: discover, backup, restore test and restore, including user ID translation.
- [ ] Rootless Docker: the same.
- [ ] Backups of these apps are written as format 3 and refused by 2.16.
- [ ] Moving an app between container engines is blocked with the plain message.
- [ ] A server with Podman and no Docker connects, shows its engines, and backs up a Podman app.
- [ ] A rootless user without memory and CPU delegation: the restore test says it cannot limit memory and does not run.
- [ ] A restore into a second user with a different subordinate ID range translates owners; one file owned by an unmappable ID refuses the whole restore.
- [ ] Image copies (load on standard input, save to a file) work for rootless Docker and rootless Podman, and a stopped step ends the engine.
- [ ] A failed rootless restore leaves no container and no data folder; Server cleanup lists a leftover restore folder.
- [ ] An app managed by a systemd unit (quadlet), an app with a native database engine and a Compose project split over two engines are each refused with their plain message.
- [ ] Moves: the preflight blocks ports below the system limit and warns when linger is off.

## Client reports and recovery time

- [ ] SMTP: a test email and the day-1 email arrive with the PDF attached (under 8 MB); a failed send retries and then alerts.
- [ ] Recovery time: the "may be low" note appears after real backups grow more than 50% past the tested one, and "not recent" after twice the test cadence.
- [ ] The PDF opens in common viewers, Hebrew names render, and no address, path or login appears in it.

## Results: local lab run, 2026-11-24

Run against the integration branch (6ca079d) with a throwaway data directory, fake test data only, a lab TrueNAS SCALE 25.10 VM
(lab NAS, VirtualBox, reached through a loopback forward) and a local folder on the test PC. The VM was powered off afterwards.
Nothing here marks a real backup or restore as validated (docs/release-validation.md): the Linux Docker integration job still does that.

| Check | Result | Evidence |
| --- | --- | --- |
| TrueNAS lab: connect with a sudo user | pass | Connected as a non-root user; readiness green (NAS version, passwordless sudo, host Python runtime, Docker, staging folder on the pool). |
| TrueNAS lab: discover apps | pass | A fake app under `/mnt/.ix-apps/app_configs` shows as a TrueNAS app with its manager and project name. |
| A NAS user without passwordless sudo gets the one-line fix | pass | A second lab user without sudo is refused with 409 and the passwordless sudo fix. |
| TrueNAS lab: back up | fail with the default (staged) delivery, pass with direct delivery | Bug 1. With delivery set to direct the backup completed (about 1.2 s of downtime) and the scrub of the stored copy passed. |
| TrueNAS lab: restore (copy) | fail | Bug 1. The plan was executable, then the upload ended with "Permission denied". |
| TrueNAS lab: restore test | fail (could not run) | Bug 1. The step "Copy backup" failed; nothing was started on the lab NAS. |
| TrueNAS lab: recovery time | not measured | No restore test passed, so the Recovery Guide has no measured time. Repeat after bug 1 is fixed. |
| TrueNAS 24.04 refused with the Kubernetes message | skipped | Needs a 24.04 VM; covered by unit tests only. |
| Local folder destination | pass for connect, backup, scrub; restore blocked by bug 1 | The same-disk warning (409, then accepted on request) behaved as documented. The encrypted backup landed in the folder and verified. The restore planned from that folder as the main copy, but could not run because of bug 1. |
| WebDAV through rclone | skipped | The pinned rclone is linux/amd64 and only inside the image; this PC has no Docker daemon and no rclone, and downloading one was not done. |
| Rootless Podman and rootless Docker | skipped: no VM | The only lab VM is the rootful TrueNAS one. Creating a Linux VM needs the owner's OK. |
| Helper runtime image over `docker load` | skipped | The VM has Docker, but this PC cannot build the pinned amd64 image tar (no Docker), and TrueNAS has Python so it uses the host runtime. The Linux integration job covers the load path. |
| Cloud drives, Unraid, Synology, SMTP and PDF checks | not in scope | They need an account, a USB-stick machine or hardware. |

### Bugs found

1. **Backup, restore and restore test fail for a NAS user who uses sudo, unless delivery is direct (high).**
   The helper runs as root through sudo and keeps its staged files in an owner-only root folder (`<stagingBase>/<job id>`,
   mode 0700, root). The staged archive is then fetched with SFTP as the SSH user, who cannot read it: `download()` in
   `src/ssh.js` (called from `src/engine.js`, around line 604) fails with "Permission denied". The restore does the reverse: the SFTP
   upload into the same root-owned folder (`uploadStream` in `src/ssh.js`, used by `sendPackage` in `src/engine.js`) is refused. The restore test copy step
   uses the same upload. Repro: connect a non-root passwordless-sudo user on a TrueNAS 25.x lab, add a Compose app, set
   `stagingRoot` to the reported `stagingBase`, run a backup (fails at "packing"), then restore it as a copy (fails at once).
   Setting `deliveryMode` to `direct` makes the backup pass because that path streams through the sudo helper. docs/nas-servers.md already lists container-runtime
   staging as unfinished, but the host-runtime sudo path is hit too. Suggested fix: do the staged file reads and writes through the sudo helper, as direct capture does.
2. **Restore through the API with `replace` is refused with "requires a safety backup and rollback adapter; unavailable" (low, probably by design).**
   `copy` (new copy) is the only restore mode that planned as executable on the lab. Confirm that the screens do not offer Replace for these servers.
3. **The readiness list shows "Enable maintenance protection before backing up a live site" in red for an app with maintenance switched off (low). Open follow-up, not fixed here: it may be by design (a restore-check contract expects that readiness answer to stay as it is).**
   The backup still ran. Repro: an app with `maintenanceRequired: false` and no domain, then `POST /api/sites/:id/readiness` (`ready` stays false).

### Re-run after the sudo package mover fix, 2026-11-24

Same lab (TrueNAS SCALE 25.10 VM, a throwaway data directory, fake data, local folder for the backups), on the branch that makes
the helper stream staged packages under sudo (docs/nas-servers.md, "Backups and restores with a sudo user"). The app used the
default staging folder, not the pool's staging base. The VM was powered off afterwards and everything the run added was removed.

| Check | Result | Evidence |
| --- | --- | --- |
| Back up (default staged delivery, sudo user) | pass | The job completed; the stored package authenticated with the recorded size and checksum. |
| Restore into a new copy | pass | The plan was executable and the restore job completed. The staging folders stayed root-only (0700). |
| Restore test | pass | All six steps (check space, copy backup, restore copy, start, check health, clean up) finished and the lab was left as before. |
| Recovery time shown | pass | A measured time (20 s on this lab) is available to the Recovery Guide after the passed test. |
| Replacement restore | refused by design | The API answers that replacement needs a safety backup and a rollback adapter; see open question Q10. Documented in docs/nas-servers.md. |
| Staged package movers on the lab's own Python | pass | `remote/test_stage_io.py` and `remote/test_nas_staging.py` (path confinement, symbolic links, hard links, `..`, size and checksum, nothing left behind) pass on the Linux VM. |

Bug 1 above is fixed; bug 2 is by design; bug 3 (the red maintenance message) is an open follow-up and was not changed.

### Notes for the next run

- Password at first-admin setup is limited to 16 characters (`src/auth.js`, setup schema).
- The lab fixture app must exit with code 0 on SIGTERM, or the clean shutdown check fails by design ("running, nonzero exit or OOM").

## Results of the manual environment runs (workflow `Environment live checks`, 2026-11-24)

Run from `.github/workflows/env-live.yml` (manual only, never a gate) on GitHub-hosted Ubuntu runners with fake data. Runs 45460162545, 45461143108, 45461792583, 45462363557, 45462984225 and 45463388393, branch `ci/env-live-checks`.

| Check | Result | Notes |
| --- | --- | --- |
| WebDAV through the pinned rclone (`rclone serve webdav` on localhost) | PASS (all six runs) | Adapter probe (write, rename, read, range, delete), a DockNest backup stored through the rclone adapter, a restore read back from WebDAV with matching data, and a wrong password refused. Not a Nextcloud or SMB check. |
| Rootless Podman 5.7.0 | Partly verified, not green | A real user with linger and a user session: DockNest discovers the rootless engine with the right user and uid. The step "Discover tags the container with its runtime" failed and is not yet explained; the check now prints what discovery returned, so one more run will show it. Backup, restore and restore test in rootless Podman are therefore not yet verified live. |
| Rootless without memory and CPU delegation | Partly verified, not green | Delegation was removed from the user's systemd instance and DockNest reported `cgroupDelegated=false` for the user. The refusal step ("cannot limit memory for user apps", nothing created) was not reached because of the same discovery step. |
| Rootless Docker | env-blocked on runner | Docker's rootless installer did not complete on the runner (the user's engine never started), so no DockNest step ran. Needs a runner or VM where the installer works. |
| Rootless Podman or Docker on Fedora or AlmaLinux (SELinux) | Not run | Real VM needed. |
| TrueNAS SCALE 24.04 and Synology | Not run | Beta and unverified; not covered by automated checks. |
