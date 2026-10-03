# Approved recovery milestones

Implementation of M1–M5 was approved on 2026-10-03, following the [architecture review](research/public-release-architecture-review.md). Production replacement and online database adapters remain separate work.

| Milestone | Implementation and evidence |
| --- | --- |
| M1 | Versioned, fingerprinted plans; Linux mount-table classification; unknown/remote/nested filesystems and unresolved dependencies block capture; source identity and topology rechecked before capture. Unit fixtures exercise blockers. |
| M2 | Per-service native binary/version detection, declared dependency graph, writers-first stop and databases-first restart; zero-exit/OOM checks; PostgreSQL control-file proof; MySQL/MariaDB slow-shutdown and current-log proof. Unit fixtures cover mismatches, cycles and rejected shutdowns. Real engine fixtures gate advertised support. |
| M3 | Separate persisted integrity, consistency, isolated restore and application dimensions with attempt history; authenticated scrubs; per-artifact checksums; configured native read-only table counts and static file-digest checks. Container health alone never marks application checks passed. |
| M4 | Durable publication/retention intent and startup reconciliation, protected latest recovery-tested point, opt-in root-owned boot recovery, encrypted SQLite/key recovery kit and separate Linux archive-copy tool. Unit fixtures exercise rename boundaries, corrupt/partial refusal, deletion interruption and wrong-passphrase/manager-loss recovery. Linux boot and permission tests remain release gates. |
| M5 | Machine-enforced exact-commit/fresh-evidence beta gate, sanitized native/mixed-engine Linux fixtures and protected-copy checks, support matrix, additive-upgrade and independent kit checks, and atomic empty-queue deployment hold/release. Real systemd host-reboot validation remains an explicit additional gate for supported boot automation. |

M1 allows local ext2/3/4, XFS, Btrfs, ZFS and overlay classification. This is a capture policy, not a claim that every filesystem has passed integration testing. NFS/CIFS/FUSE/tmpfs source mounts, nested mounts and unclassified sources require a reviewed adapter. Root symlink mappings are rejected. External-writer absence remains an explicit operator declaration; mount discovery cannot prove all external dependencies are known.

`POST /api/sites/:id/plan` returns a redacted plan without source paths, environment values or credentials. The encrypted manifest retains the full plan needed for recovery. Existing generic sites retain their explicit clean-shutdown requirement.

Selected upstream references: [Agency Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) for explicit contracts and compensating recovery, and [Agency Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for evidence boundaries. A delegated safety review and focused legacy/Redis integration fixture work applied these references.

Verification: `npm run check`; real Linux integration remains required before advertising capture/restore support. A unit-test pass does not establish database consistency or recoverability.
