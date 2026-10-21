# Product metrics without telemetry

Date: 2026-10-21. Owner: Product Manager.

**Constraint:** DockNest does not phone home. The server code makes no outbound HTTP calls of its own (there are no `fetch` / `http.request` calls in `src/`), and that stays the default. Every metric below comes from one of three sources:

1. data that already sits on the operator's own install and is shown only to them;
2. public or owner-visible GitHub signals;
3. tests and CI the project runs itself.

Opt-in ideas are listed separately, each with a justification.

Baseline on 2026-10-21 (`gh repo view`): 3 stars, 0 forks, 0 issues, Discussions enabled, repository created 2026-10-19.

## 1. North-star metric (local only, per install)

**Protected sites with a recent passed isolated restore** = sites whose latest `isolatedRestore` result is `passed` within the site's target window (default proposal: 30 days) ÷ sites with an enabled schedule.

- **Why:** it measures the product's promise ("can I bring this site back?") rather than activity ("did a job finish?").
- **Source:** the existing `backup_verifications` / `backup_verification_history` tables and `policies.enabled` (`src/db.js`). No new collection is needed.
- **Where shown:** dashboard and readiness view (backlog PM-18). It never leaves the install.
- **Companion results:** the same ratio for `application` = passed, and the age of the last usable capture compared with each site's schedule.
- **Caveat:** until scheduled drills exist (2.5.0), the value depends on operators running restores by hand. Expect it to stay low. That gap is itself the signal behind roadmap item R9.

## 2. Project adoption signals (public or owner-visible)

| Metric | Source | Why it matters | Caveat |
| --- | --- | --- | --- |
| Stars, forks, watchers | GitHub repo | Awareness and the trust that comes with it. Backup buyers look at adoption | Vanity metric. Never a goal on its own. Track the weekly trend, not the total |
| GHCR image pulls | GHCR package page (public count, available once signed images ship in 2.1.0) | Closest no-telemetry proxy for installs and upgrades | Counts CI, retries and re-pulls. Use as a trend only |
| Release asset downloads | `gh api repos/DahanItamar/DockNest/releases` → `download_count` | Upgrade uptake per release | Only if assets are attached. Includes bots |
| Repository traffic (views, unique visitors, clones; 14-day window) | GitHub Insights (owner-only, aggregate) | Shows whether a launch post or listing actually drove visits | Aggregated by GitHub, with no per-user data. Export monthly or it is lost |
| Issues opened / closed, median time to first response | GitHub issues | Responsiveness builds trust for a backup tool. Target: first response within 3 days | A low issue count early on means few users, not high quality |
| Install reports: success vs failure, failure step | Install-report issue form (backlog PM-25) | Directly measures install success without telemetry | Self-selected reporters. Failed installs are under-reported |
| Discussions: "Show your setup" posts, Q&A threads answered | GitHub Discussions | Persona validation (site counts, server counts, databases) | Small sample. Anonymized by design |
| External contributors (merged PRs from non-maintainers) | GitHub | Sustainability, given the maintainer-bandwidth threat | Lags adoption by months |

**Review cadence:** monthly snapshot recorded by the maintainer outside Git, or as aggregate numbers only in a release note. Every launch or listing gets a 30/60/90-day review.

## 3. Quality and outcome metrics measured in tests and CI

These show whether the product keeps its promises, without needing users to report anything.

| Metric | How measured | Target / use |
| --- | --- | --- |
| **Time to first passed isolated restore** (clean VPS → manager installed → server, site and storage added → backup → isolated restore passed) | Scripted walkthrough on Linux fixtures, per release (backlog PM-21), with each step timed | Baseline on first run. Goal: under 60 min for the synthetic site. Regressions block release |
| **Upgrade safety:** % of upgrade-path fixtures with an exact state match | PM-01 / PM-10 suites (N-2→N, N-1→N, downgrade from snapshot) | 100%, or the release is blocked. This is the owner's first rule |
| Linux integration pass rate per release | `npm run test:integration` evidence in `docs/acceptance.md` | 100% on the support-matrix rows that the release advertises |
| Supported-configuration coverage | Rows in [support-matrix.md](../support-matrix.md) with current-release evidence ÷ advertised rows | 100% for advertised rows. Unproven rows are labelled, not advertised |
| Measured site pause time per fixture site | Integration run (downtime is already recorded per backup) | Trend per release. A regression of more than 20% needs an explanation |
| Fixture restore duration (fixture RTO) | Integration run, and later scheduled drills | Trend. Feeds the RTO wording in docs |
| Storage cost vs restic / Kopia | Benchmark (PM-19) | Published as-is. Informs Q6 |
| Honest-claims check | PM-04 string guard + count of README capability claims that link to evidence | No merged "Verified" claim. Every comparison row is sourced |
| Security posture | Open GitHub security advisories, days to patch, `npm audit` high/critical count, gitleaks results in CI | 0 open high/critical findings at release |
| Test health | Flaky-test reruns per month in CI | Trending down |

## 4. Opt-in ideas (each needs owner approval, see [open-questions Q4](open-questions.md))

| Idea | What it reveals | Why it is acceptable | Guardrails |
| --- | --- | --- | --- |
| **"Copy anonymized setup summary" button** in System health | Counts only: number of servers, sites (Docker/static), engines in use, Docker/Python versions, architecture, storage type, DockNest version | The operator sees the exact JSON and decides whether to paste it into an install report or discussion. Nothing is sent automatically | No hostnames, domains, paths, IDs or error text. A unit test asserts the field allowlist |
| **Link to a feedback discussion in the "What's new" modal** (2.2.0) | Qualitative feedback after upgrades | It is a plain link. No tracking parameters, no call to any service | Opens github.com only when clicked |
| **Opt-in update check** (2.2.0) | Nothing to the project: GitHub does not share API caller data with repository owners | Needed for the updater. Disclose it in Settings | Off by default or clearly disclosed (Q4). No install ID, no custom user agent with identifiers |
| **Opt-in public "recovery drill passed" badge** (after 2.5.0) | Nothing to the project. The operator could publish their own badge | Social proof for agencies, under the operator's control | Served by the operator's own install, never by a project service |

**Rejected:** unique install IDs, background usage pings, third-party crash reporting (such as Sentry) by default, and analytics scripts in the web UI. Each conflicts with the no-phone-home principle and with the trust the product sells.

## 5. Anti-metrics (do not optimize)

- **Job success rate on its own.** A finished capture is not a recovery. Always pair it with the north star.
- **Number of storage backends or features.** Scope growth competes with maintainer bandwidth and with upgrade safety.
- **Stars from launch spikes.** Track retention signals (install reports, returning issue authors) instead.
