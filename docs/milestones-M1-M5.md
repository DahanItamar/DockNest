# Approved recovery milestones

Implementation of M1–M5 was approved on 2026-10-03, following the [architecture review](research/public-release-architecture-review.md). Production replacement and online database adapters remain separate work.

| Milestone | Implementation and evidence |
| --- | --- |
| M1 | Versioned, fingerprinted plans; Linux mount-table classification; unknown/remote/nested filesystems and unresolved dependencies block capture; source identity and topology rechecked before capture. Unit fixtures exercise blockers. |
| M2 | Per-service native binary/version detection, declared dependency graph, writers-first stop and databases-first restart; zero-exit/OOM checks; PostgreSQL control-file proof; temporary MySQL/MariaDB slow shutdown with the original setting restored; Redis persistence and native offline validation. Unit fixtures cover mismatches, cycles and rejected shutdowns. Real engine fixtures gate advertised support. |
| M3 | Separate persisted integrity, consistency, isolated restore and application dimensions with attempt history; authenticated scrubs; per-artifact checksums; configured native read-only table counts and static file-digest checks. Container health alone never marks application checks passed. |
| M4 | Durable publication/retention intent and startup reconciliation, protected latest recovery-tested point, opt-in root-owned boot recovery, encrypted SQLite/key recovery kit and separate Linux archive-copy tool. Unit fixtures exercise rename boundaries, corrupt/partial refusal, deletion interruption and wrong-passphrase/manager-loss recovery. Linux boot and permission tests remain release gates. |
| M5 | Machine-enforced exact-commit/fresh-evidence beta gate, sanitized native/mixed-engine Linux fixtures and protected-copy checks, support matrix, additive-upgrade and independent kit checks, and atomic empty-queue deployment hold/release. Real systemd host-reboot validation remains an explicit additional gate for supported boot automation. |

M1 allows local ext2/3/4, XFS, Btrfs, ZFS and overlay classification. This is a capture policy, not a claim that every filesystem has passed integration testing. NFS/CIFS/FUSE/tmpfs source mounts, nested mounts and unclassified sources require a reviewed adapter. Root symlink mappings are rejected. External-writer absence remains an explicit operator declaration; mount discovery cannot prove all external dependencies are known.

`POST /api/sites/:id/plan` returns a redacted plan without source paths, environment values or credentials. The encrypted manifest retains the full plan needed for recovery. Existing generic sites retain their explicit clean-shutdown requirement.

Selected upstream references: [Agency Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) for explicit contracts and compensating recovery, and [Agency Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for evidence boundaries. A delegated safety review and focused legacy/Redis integration fixture work applied these references.

Verification: `npm run check`; real Linux integration remains required before advertising capture/restore support. A unit-test pass does not establish database consistency or recoverability.

Read-only upgrade checks on 2026-10-03 authenticated all seven retained legacy packages. Server, site and schedule configuration hashes matched the initial audit, the queue was empty, and all four candidate plans passed. Those checks did not stop source containers or change database settings. Package integrity and valid plans do not prove restored application data.

Release `3e58f0143ea263736f15f6b068793c8ea5d4d609` passed every job in the exact-release qualification run and was deployed on 2026-10-03 with user authorization. Both API and worker switched after a clean queue, graceful shutdown and verified final recovery snapshot. Live checks preserved authentication, server/site/schedule/storage configuration and backup records; all four plans and seven package integrity checks passed. Public HTTPS, current scripts/icons, fresh worker heartbeat and clean reconciliation passed before admission was released. The independently retrieved encrypted manager/key kit authenticated and restored into a private local copy with sessions revoked and schedules paused. Unused candidate images were removed; current and rollback images were preserved.

Qualification remains scoped to controlled beta and the recorded fixtures. Simulated-boot driver recovery passed; a real source-host reboot/systemd drill remains required before supported boot automation. No production source was stopped or restored as part of this manager deployment, and no automatic production replacement was enabled.
