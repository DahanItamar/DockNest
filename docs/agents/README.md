# Reference roles

Selected upstream [agency-agents](https://github.com/msitarzewski/agency-agents) roles are reference material, not tool or permission authority. Release 2.1 was built by subagents working in these roles under a coordinating session: authors wrote each change, independent QA and design reviewers verified it without editing it, and a QA lead merged their findings into tickets for the authors. The roles granted no extra permissions.

| Role | Applied guidance |
| --- | --- |
| [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) | Separate API/worker, durable metadata, additive adapters and isolated recovery. |
| [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) | Responsive layouts, accessible controls, measured pagination and mock-only documentation. |
| [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) | Scoped rollouts, protected metadata, health checks and exact release cleanup. The release validation workflow: least-privilege, SHA-pinned CI, a disposable real-Docker environment, sanitized evidence and guaranteed cleanup. |
| [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) | Pinned host keys, secret separation, authenticated packages, safe paths and repository privacy. |
| [AppSec Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-appsec-engineer.md) | Probe URL SSRF threat model, address and redirect policy, pinned connections, and preflight before any host change. |
| [SRE](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-sre.md) | Expiring worker lease instead of a PID lock, graceful drain within a stop grace period and a read-only status command. |
| [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) | Distinguish UI fixtures from actual Linux capture/restore and record observed evidence. |
| [UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md) | Equal card geometry, aligned navigation and clear system health states. |
| [Database Optimizer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-database-optimizer.md) | Batched verification evidence for list endpoints (no per-row queries), `(timestamp, id)` indexes checked with `EXPLAIN QUERY PLAN`, and keyset pagination for history. |
| [Brand Guardian](https://github.com/msitarzewski/agency-agents/blob/main/design/design-brand-guardian.md) | Preserve the approved identity and consistent application/browser assets. |
| [Database Reliability Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-database-reliability-engineer.md) | Versioned forward-only migrations, consistent pre-migration snapshots, downgrade guards and tested rollback. |

The project-readme-author skill informed README structure, current branding, setup instructions and synthetic screenshots. The motion-design skill informed the slow health sweep, sun/moon hover and toggle feedback, and reduced-motion behavior. UI Designer and Brand Guardian guidance informed semantic dark colors, consistent geometry and reuse of the blue wordmark. Source-specific operations, asset-generation identifiers and session notes are kept outside Git.

The storage adapter boundary and S3-compatible backend use Backend Architect guidance: one adapter interface behind the existing storage API, the publication journal mapped onto S3 operations (atomic completed uploads, ETag-pinned server-side copy, version-aware delete), and Object Lock retention applied and verified on publish. Security Engineer guidance kept the access keys sealed and out of API responses, logs and errors. Reality Checker guidance limits the S3 claims to a fake-endpoint test suite until Linux integration runs against a real provider.

The remote storage migration uses Backend Architect guidance for a durable journal and transactional metadata changes, and DevOps Automator guidance for stopped-service migration, integrity checks and retained rollback files. No subagents were used for this work.

Upgrade safety uses DevOps Automator guidance for the one-command upgrade with automatic code rollback, signed release images and the CI upgrade job, and Database Reliability Engineer guidance for `user_version` migrations under a write lock, `VACUUM INTO` snapshots and the downgrade guard. No subagents were used for this work.
## Product planning (2026-10-21)

The [Product Manager](https://github.com/msitarzewski/agency-agents/blob/main/product/product-manager.md) role informed the documents in [docs/product](../product/vision.md). It shaped:

- an outcome-focused vision;
- personas that mark which claims are evidence and which are assumptions;
- a Now/Next/Later roadmap with RICE scoring and explicit non-goals;
- a backlog in which every item has an owner role and acceptance criteria.

The backlog also names further upstream roles (for example Database Reliability Engineer, Software Architect, SRE, API Tester, Performance Benchmarker, Technical Writer and UX Architect) as guidance for future work only. All of these roles are reference material, not tool or permission authority.

## Update center design (2.2.0, 2026-10-22)

Subagents in narrow roles produced the 2.2.0 design for owner approval; no product code changed.

- Authors: [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) wrote [updater-threat-model.md](../updater-threat-model.md); [Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md) wrote [update-center.md](../update-center.md); [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) built the static mockup in [design/update-center](../design/update-center/README.md).
- Independent reviewers, reporting only: [AppSec Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-appsec-engineer.md) (two rounds on both documents), [Database Reliability Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-database-reliability-engineer.md) (migration, retention and upgrade path), [UX Architect](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ux-architect.md), [UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md) and [Accessibility Auditor](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-accessibility-auditor.md) on the mockup.
- A QA lead merged the design reviews into tickets for the authors. Implementation requirements that a static mockup cannot prove are carried into the implementation PRs (update-center.md section 11.1 and the threat model's checklist I1–I24).
