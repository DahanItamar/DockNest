# Approved recovery milestones

Implementation of M1–M5 was approved on 2026-10-03, following the [architecture review](research/public-release-architecture-review.md). Production replacement and online database adapters remain separate work.

| Milestone | Implementation and evidence |
| --- | --- |
| M1 | Versioned, fingerprinted plans; Linux mount-table classification; unknown/remote/nested filesystems and unresolved dependencies block capture; source identity and topology rechecked before capture. Unit fixtures exercise blockers. |
| M2 | In progress: per-service database contracts, native engine/version checks, shutdown and dependency ordering. |
| M3 | Pending: independent integrity, consistency and isolated application recovery evidence. |
| M4 | Pending: durable publication/retention, boot recovery and independent state/key recovery. |
| M5 | Pending: supported configuration matrix, sanitized fixtures and release gates. |

M1 allows local ext2/3/4, XFS, Btrfs, ZFS and overlay classification. This is a capture policy, not a claim that every filesystem has passed integration testing. NFS/CIFS/FUSE/tmpfs source mounts, nested mounts and unclassified sources require a reviewed adapter. Root symlink mappings are rejected. External-writer absence remains an explicit operator declaration; mount discovery cannot prove all external dependencies are known.

`POST /api/sites/:id/plan` returns a redacted plan without source paths, environment values or credentials. The encrypted manifest retains the full plan needed for recovery. Existing generic sites retain their explicit clean-shutdown requirement.

Selected upstream references: [Agency Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) for explicit contracts and compensating recovery, and [Agency Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for evidence boundaries. No subagents were used.

Verification: `npm run check`; real Linux integration remains required before advertising capture/restore support. A unit-test pass does not establish database consistency or recoverability.
