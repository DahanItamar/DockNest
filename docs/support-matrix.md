# Controlled beta support matrix

The M1–M5 code is gated by `npm run check`, privacy/history checks, browser checks and versioned real Linux evidence. Feature implementation is not evidence that an arbitrary site works.

| Configuration | Policy / required evidence |
| --- | --- |
| Rootful Linux Docker, Python 3, x86_64; Docker 28+ for grouped copies | Tested Docker version is recorded by each integration run. Other architectures need their own image/capture/restore evidence. |
| Local bind mounts and default local Docker volumes | Actual Linux mount table, root identity, nested mount detection and exclusive-writer declaration required. Integration uses overlay/local filesystems and a separate bind file. |
| ext2/3/4, XFS, Btrfs, ZFS | Classifier permits them; acceptance is limited to configurations with dedicated capture/restore evidence. Classifier recognition alone does not establish support. |
| NFS/NFS4, CIFS, FUSE, unknown filesystems; nested mounts | Blocked. Linux parser fixtures cover remote filesystem classification; actual nested/tmpfs fixtures verify preflight refusal. No network filesystem adapter is advertised. |
| PostgreSQL 16, MySQL 8.4, MariaDB 11.4 official images | Candidate cold adapters; exact installed version, image ID/digest, native clean-shutdown evidence and real isolated data recovery must pass for the release. No arbitrary engine/version promise. |
| Mixed selected engines | Same writer boundary and ordering; dedicated isolated fixture validates each engine's configured checks. |
| Generic application / SQLite fixture | Explicit declared clean shutdown plus zero exit; actual integration verifies fixture database records/files. No universal database consistency contract. |
| Other stateful images, stopped native databases, external PostgreSQL tablespaces, unsupported credentials/tool layouts | Blocked or require reviewed adapters. External dependencies cannot be inferred universally from Docker labels. |
| Static nginx roots | Discovered native static root, stable captured/extracted tree; live hosting remains unchanged. Application/CDN behavior needs independent review. |
| Restore | Fresh owned paths, original exact images, no published ports, none/internal isolated networks; no replacement, production cutover or arbitrary mappings. |
| Source boot recovery | Opt-in systemd helper. CI tests its Linux driver with simulated boot identity change; a real provider/VM reboot drill is still required before treating automatic host recovery as supported. Use `--require-host-reboot` to enforce that gate. |
| Independent state/key recovery | Authenticated kit using a consistent SQLite snapshot, independent passphrase and clean target; matching release/environment credentials must be kept separately. |
| Independent protected copy | Root-controlled archive on a separate Linux host with no manager deletion credential; manager-uid deletion refusal is tested. Not a WORM guarantee. |

## Deployment and upgrade gate

1. Pass all CI jobs for the exact commit and retrieve sanitized evidence. Aggregate successful Node/privacy/browser results with the matching Linux report. Run `node scripts/beta-gate.js EVIDENCE.json COMMIT` and, when enabling supported boot automation, `--require-host-reboot` with real reboot evidence.
2. On the current manager, run `node scripts/deployment-preflight.js hold`. It checks the queue, unresolved recovery and pending publication/retention operations atomically and blocks new enqueues/scheduler work. A failed check changes nothing. Recheck after the worker has stopped gracefully.
3. Create and verify an encrypted recovery kit, and retain the exact prior application image plus independent mounted credentials. Never copy a live SQLite file without its WAL/online backup protocol.
4. Build and start the new API/worker against the preserved state only after both old processes are stopped. Additive migrations must preserve administrator/password/factors and existing recovery history; CI includes old-schema migration fixtures and repeated startup.
5. Validate health, anonymous API rejection, worker heartbeat, existing site plan/readiness blockers and storage reachability. Run an isolated fixture restore with configured data checks. New safety blockers require explicit configuration review; do not weaken them to make an old site appear ready.
6. Run `node scripts/deployment-preflight.js release` only after verification. Keep rollback state/image until acceptance. Do not restore an old manager snapshot over new jobs or remove in-use Docker images/volumes.

Until candidate engine fixtures pass, native engines remain unqualified. A beta gate must fail on missing, stale, mismatched or failed evidence; screenshots and container health do not substitute for data recovery.

## Sanitized support intake

Include commit, Node/Python/Docker versions, engine/version and immutable image digest, filesystem types, plan blocker category, anonymized topology and verification dimensions. Use synthetic names/addresses. Exclude environment dumps, Compose secrets, credentials, decrypted manifests, private keys, production domains, full database output and archive contents. Reproduce issues in disposable fixture hosts before advertising a newly supported configuration.
