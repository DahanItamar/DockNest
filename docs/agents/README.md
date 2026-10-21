# Reference roles

Selected upstream [agency-agents](https://github.com/msitarzewski/agency-agents) roles are reference material, not tool or permission authority. No subagents were spawned for the current work.

| Role | Applied guidance |
| --- | --- |
| [Backend Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-backend-architect.md) | Separate API/worker, durable metadata, additive adapters and isolated recovery. |
| [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) | Responsive layouts, accessible controls, measured pagination and mock-only documentation. |
| [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) | Scoped rollouts, protected metadata, health checks and exact release cleanup. |
| [Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md) | Pinned host keys, secret separation, authenticated packages, safe paths and repository privacy. |
| [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) | Distinguish UI fixtures from actual Linux capture/restore and record observed evidence. |
| [UI Designer](https://github.com/msitarzewski/agency-agents/blob/main/design/design-ui-designer.md) | Equal card geometry, aligned navigation and clear system health states. |
| [Brand Guardian](https://github.com/msitarzewski/agency-agents/blob/main/design/design-brand-guardian.md) | Preserve the approved identity and consistent application/browser assets. |

The project-readme-author skill informed README structure, current branding, setup instructions and synthetic screenshots. The motion-design skill informed the slow health sweep, sun/moon hover and toggle feedback, and reduced-motion behavior. UI Designer and Brand Guardian guidance informed semantic dark colors, consistent geometry and reuse of the blue wordmark. Source-specific operations, asset-generation identifiers and session notes are kept outside Git.

The storage adapter boundary and S3-compatible backend use Backend Architect guidance: one adapter interface behind the existing storage API, the publication journal mapped onto S3 operations (atomic completed uploads, ETag-pinned server-side copy, version-aware delete), and Object Lock retention applied and verified on publish. Security Engineer guidance kept the access keys sealed and out of API responses, logs and errors. Reality Checker guidance limits the S3 claims to a fake-endpoint test suite until Linux integration runs against a real provider.

The remote storage migration uses Backend Architect guidance for a durable journal and transactional metadata changes, and DevOps Automator guidance for stopped-service migration, integrity checks and retained rollback files. No subagents were used for this work.
