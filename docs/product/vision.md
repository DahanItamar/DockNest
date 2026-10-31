# Product vision

Owner: Product Manager (reference role: [agency-agents Product Manager](https://github.com/msitarzewski/agency-agents/blob/main/product/product-manager.md); approach only, no extra permissions).
Date: 2026-10-21. Baseline: `main` at DockNest 2.0.0 (`package.json` version `2.0.0`), with the 2.1.0 work listed in [roadmap.md](roadmap.md) still on branches.

Related: [personas](personas.md) · [competitive landscape](competitive-landscape.md) · [roadmap](roadmap.md) · [backlog](backlog.md) · [metrics](metrics.md) · [open questions](open-questions.md)

## Vision

A person who runs Docker sites on a few Linux servers should be able to answer one question quickly and honestly: "If this server disappeared tonight, could I bring this site back, how much data would I lose, and how do I know?" DockNest exists to answer that question. It captures each site as a whole (images, writable layers, volumes, bind mounts, Compose and configuration, and database data captured after a checked clean shutdown). It stores those captures encrypted in the operator's own storage and restores them into isolated copies. It records what each check actually proved. The product succeeds when a recovery claim on the dashboard holds up in a real disaster, not when a job shows a green status.

## Positioning statement

For **small web agencies and developers who manage several Docker sites on remote Linux VPSs**, DockNest is a **self-hosted, site-level disaster-recovery dashboard**. It **backs up each site as one restorable unit and proves, with recorded evidence, how far a restore has been verified.** General backup engines such as restic, Kopia and Backrest copy files and check repository integrity. Volume tools such as docker-volume-backup and VolumeVault copy Docker volumes. **DockNest captures the whole site (images, writable layers, mounts, configuration and database data captured after a checked clean shutdown) over pinned SSH, and restores it into an isolated copy without touching production.**

Short form: *site-level disaster recovery for Docker on remote Linux servers.*

## What DockNest is not

| Not this | Why | What to use instead |
| --- | --- | --- |
| A general file or laptop backup tool | The unit of backup is a Docker or static nginx site on a Linux server, not arbitrary paths | restic, Kopia, Backrest |
| A deduplicating, incremental backup engine | Each recovery point is a full, self-contained encrypted package (`docs/backup-format.md`). Storage cost is higher than with dedup engines | restic, Kopia, Borg |
| A zero-downtime or online backup tool | Docker captures pause the site's writers. Downtime is measured and shown, not hidden. Native online adapters are a later idea, not a promise | Database-native tools (`pg_basebackup`, `mariadb-backup`) |
| A production failover or cutover system | Restore creates isolated new copies only. Replacing a live site is blocked in code (`planRestore` in `src/engine.js`) until a safety-backup and rollback workflow is validated | Manual cutover after an isolated restore is reviewed |
| A Kubernetes, Swarm-cluster or Windows-container tool | The support matrix covers rootful Linux Docker on x86_64 only | Velero (Kubernetes) and similar |
| A hosted SaaS | Self-hosted under AGPL-3.0. No hosted offering exists (see [open questions](open-questions.md)) | — |
| A monitoring or uptime product | Health checks exist to protect backups and restores, not to replace monitoring | Uptime Kuma, Healthchecks, provider monitoring |
| A guarantee that every application workflow recovers | Evidence covers the configured checks and nothing more ([recovery verification](../recovery-verification.md)) | Application-specific acceptance tests |

## Guiding product principles

1. **Upgrades never break existing installs' data or configuration.** This is the owner's first rule and overrides feature speed. Every schema change goes through a migration that can be tested against old-schema fixtures, is preceded by a snapshot, and has a documented rollback. A new safety blocker can stop a site from looking ready. It must not silently change saved settings to make an old site pass. Any feature that edits stored state must be designed so that an older release can be restored over a pre-upgrade snapshot.
2. **Only claim what the evidence shows.** Integrity, consistency, isolated restore and application checks are four separate results (`docs/recovery-verification.md`). The UI, README, release notes and marketing must never merge them into one "Verified" claim. Nothing is called validated without real Linux Docker integration evidence (AGENTS.md). Unknown is shown as unknown.
3. **The manager never gets the Docker socket.** The `api` and `worker` containers run read-only with all capabilities dropped and no Docker socket mount (`compose.yaml`). Docker work happens on source servers through a versioned Python helper over SSH with pinned host keys. A feature that needs the socket inside the manager, including self-update, has to find another design. Today that means a host-side updater, as planned for 2.2.0.
4. **No phone-home.** Besides the connections an administrator sets up (servers, storage, alert channels), the manager's only unprompted outbound call is the update check, which is opt-in, sends the minimum data and can be turned off. Product metrics come from public signals and tests ([metrics.md](metrics.md)).
5. **Production stays untouched by default.** Restores go to fresh paths with no published ports and isolated or no networks. Maintenance mode never hides a failed restart. Failures leave explicit `recovery_required` state rather than a guess.
6. **Secrets stay out of Git, logs, notifications and reports.** Sanitized evidence uses synthetic names. New output channels, such as notifications, PDF reports and support bundles, need a redaction review before release.
7. **Separate who can delete backups.** A compromised manager should not be able to delete every copy. Independent copies need deletion authority that the manager does not hold. Today that is `scripts/protected-copy.py` on a separate host. S3 Object Lock adds an immutable copy the manager cannot delete, but the bucket owner account still can, so it does not replace an independent copy.
8. **Small, evidenced increments.** Each change is a small section commit tested with `npm run check`. Every capture or restore change also needs `npm run test:integration` on Linux before it is described as working.

## North-star metric

**Sites with a recent passed isolated restore.** This is the share of protected sites whose latest isolated restore passed within the site's target window (default proposal: 30 days). It is measured locally on each install and shown to the operator, never sent home. See [metrics.md](metrics.md) for the measurement and the public proxies used for the project itself.
