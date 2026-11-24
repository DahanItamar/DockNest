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

- [ ] The runtime image is built for amd64 and loaded over SSH (`docker load`) on a NAS with no Python.
- [ ] TrueNAS SCALE 25.x lab: connect, discover apps, back up, restore test; 24.04 is refused with the Kubernetes message.
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
