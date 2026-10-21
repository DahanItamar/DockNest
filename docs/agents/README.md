# Reference roles

Selected upstream [agency-agents](https://github.com/msitarzewski/agency-agents) roles are reference material, not tool or permission authority. No subagents were spawned for the current work.

| Role | Applied guidance |
| --- | --- |
| [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) | Separate API/worker, durable metadata, additive adapters and isolated recovery. |
| [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) | Responsive layouts, accessible controls, measured pagination and mock-only documentation. |
| [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) | Scoped rollouts, protected metadata, health checks and exact release cleanup. |
| [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) | Pinned host keys, secret separation, authenticated packages, safe paths and repository privacy. |
| [AppSec Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-appsec-engineer.md) | Probe URL SSRF threat model, address and redirect policy, pinned connections, and preflight before any host change. |
| [SRE](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-sre.md) | Expiring worker lease instead of a PID lock, graceful drain within a stop grace period and a read-only status command. |
| [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) | Distinguish UI fixtures from actual Linux capture/restore and record observed evidence. |
| [UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md) | Equal card geometry, aligned navigation and clear system health states. |
| [Database Optimizer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-database-optimizer.md) | Batched verification evidence for list endpoints (no per-row queries), `(timestamp, id)` indexes checked with `EXPLAIN QUERY PLAN`, and keyset pagination for history. |
| [Brand Guardian](https://github.com/msitarzewski/agency-agents/blob/main/design/design-brand-guardian.md) | Preserve the approved identity and consistent application/browser assets. |

The project-readme-author skill informed README structure, current branding, setup instructions and synthetic screenshots. The motion-design skill informed the slow health sweep, sun/moon hover and toggle feedback, and reduced-motion behavior. UI Designer and Brand Guardian guidance informed semantic dark colors, consistent geometry and reuse of the blue wordmark. Source-specific operations, asset-generation identifiers and session notes are kept outside Git.

The remote storage migration uses Backend Architect guidance for a durable journal and transactional metadata changes, and DevOps Automator guidance for stopped-service migration, integrity checks and retained rollback files. No subagents were used for this work.

## Product planning (2026-10-21)

The [Product Manager](https://github.com/msitarzewski/agency-agents/blob/main/product/product-manager.md) role informed the documents in [docs/product](../product/vision.md). It shaped:

- an outcome-focused vision;
- personas that mark which claims are evidence and which are assumptions;
- a Now/Next/Later roadmap with RICE scoring and explicit non-goals;
- a backlog in which every item has an owner role and acceptance criteria.

The backlog also names further upstream roles (for example Database Reliability Engineer, Software Architect, SRE, API Tester, Performance Benchmarker, Technical Writer and UX Architect) as guidance for future work only. All of these roles are reference material, not tool or permission authority.
